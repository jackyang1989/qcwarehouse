import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";
import { oidcSettings, postmarkSettings, type OidcProvider } from "./integrations";
import { pool, transaction, type DB } from "../db";
import { Problem, audit, code, event, guard, hash, isDemo, lock, one, uuid, type Actor } from "./common";

const token = () => randomBytes(32).toString("base64url");
export function appOrigin() {
  return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
}
function pepper() {
  const value = process.env.AUTH_OTP_PEPPER;
  guard(value && value.length >= 32, "AUTH_UNAVAILABLE", "Authentication configuration is incomplete.", 503);
  return value;
}
export function reportDownloadSignature(actorId:string,reportId:string,expires:number) {
  return createHmac("sha256",pepper()).update(`report-download:${actorId}:${reportId}:${expires}`).digest("base64url");
}
export function reportShareToken(actorId:string,orderId:string,version:number,key:string) {
  return createHmac("sha256",pepper()).update(`report-share:${actorId}:${orderId}:${version}:${key}`).digest("base64url");
}
export function verifyReportDownload(actorId:string,reportId:string,expiry:string,signature:string) {
  const expires=Number(expiry);
  guard(Number.isSafeInteger(expires) && expires>Date.now() && /^[A-Za-z0-9_-]{43}$/.test(signature)
    && timingSafeEqual(Buffer.from(signature),Buffer.from(reportDownloadSignature(actorId,reportId,expires))),
    "DOWNLOAD_EXPIRED","Request a new report download link.",403);
}
export function cookie(name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
export function csrfCookie(value: string, age: number) {
  return `qcw_csrf=${value}; Path=/; SameSite=Lax; Max-Age=${age}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
export function csrfTokenFor(secret: string) {
  return createHmac("sha256", pepper()).update("csrf:" + hash(secret)).digest("base64url");
}
export function verifyCsrfToken(secret: string, candidate: string) {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(csrfTokenFor(secret)));
}
export function getCookie(request: Request, key: string) {
  return request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(key + "="))?.slice(key.length + 1) ?? "";
}
export function actorFrom(request:Request) {
  return actorForSession(getCookie(request,"session"));
}
export async function actorForSession(sid:string|undefined):Promise<Actor|null> {
  if (!sid) return null;
  const actor = (await pool.query<Actor>(`
    select u.id,s.kind,case when s.kind='customer' then p.org_id end as org,
    array(select role from staff_roles where user_id=u.id and s.kind='staff') as roles
    from sessions s join users u on u.id=s.user_id left join customer_receiving_profiles p on p.user_id=u.id
    where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and s.auth_version=u.auth_version and u.status='active'
  `, [hash(sid)])).rows[0];
  return actor ?? null;
}
export async function requireStaffMfa(db:DB,actor:Actor,sessionHash:string,maxAgeMinutes=10) {
  const verified=(await db.query(`select s.id from sessions s join users u on u.id=s.user_id where s.token_hash=$1
    and s.user_id=$2 and s.kind='staff' and s.revoked_at is null and s.expires_at>now()
    and s.auth_version=u.auth_version and u.status='active'
    and s.mfa_at>now()-make_interval(mins=>$3)`,[sessionHash,actor.id,maxAgeMinutes])).rowCount;
  guard(verified,"STAFF_REAUTH_REQUIRED","Sign in with your staff second factor again before continuing.",403);
}
async function session(db: DB, userId: string, kind: Actor["kind"], mfa = false) {
  const secret = token();
  const interval = kind === "customer" ? "30 days" : "12 hours";
  await db.query(`insert into sessions(id,user_id,kind,token_hash,auth_version,expires_at,mfa_at)
    select $1,id,$2,$3,auth_version,now()+($4::interval),case when $5 then now() end from users where id=$6`,
    [uuid(),kind,hash(secret),interval,mfa,userId]);
  return secret;
}
type Identity = { provider: string; issuer: string; subject: string; email: string };
type IdentityAccount = { id:string; status:string; staff:boolean; identity_status:string };
async function findIdentityAccount(db: DB, {provider,issuer,subject,email}: Identity) {
  return (await db.query<IdentityAccount>(`select u.id,u.status,i.status identity_status,
    exists(select 1 from staff_roles where user_id=u.id) staff
    from auth_identities i join users u on u.id=i.user_id left join user_emails e on e.id=i.email_id
    where i.provider=$1 and i.issuer=$2 and (
      ($1='email_otp' and e.normalized_email=$4 and e.login_enabled and e.verified_at is not null)
      or ($1<>'email_otp' and i.subject=$3))`,[provider,issuer,subject,email])).rows[0];
}
function lockIdentity(db:DB, {provider,issuer,subject,email}:Identity) {
  // OTP resolves to a stable verified email record after registration. Serialize first use by address.
  return lock(db,provider==="email_otp"?"email:"+email:"identity:"+JSON.stringify([provider,issuer,subject]));
}
function requireActiveIdentity(account:IdentityAccount) {
  guard(account.status==="active" && account.identity_status==="active","ACCOUNT_UNAVAILABLE","This account is unavailable.",403);
}
export async function addEmailOtpIdentity(db:DB,userId:string,emailId:string) {
  await db.query(`insert into auth_identities(user_id,provider,issuer,subject,status,linked_at,email_id)
    values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)`,[userId,emailId]);
}
async function signInIdentity(db: DB, identity: Identity, browser: string, allowDemoStaff = false) {
  const {provider,issuer,subject,email} = identity;
  await lockIdentity(db,identity);
  const account=await findIdentityAccount(db,identity);
  if (account) {
    requireActiveIdentity(account);
    guard(!account.staff || (allowDemoStaff && isDemo() && email.endsWith("@qcw.test")), "STAFF_LOGIN_REQUIRED", "Use the staff sign-in page.",403);
    return { state: "signed_in" as const, secret: await session(db,account.id,account.staff ? "staff" : "customer", !!account.staff), kind: account.staff ? "staff" : "customer" };
  }
  // Provider email is never used to attach a new identity to an existing account.
  const existing = (await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[email])).rowCount;
  guard(!existing,"IDENTITY_LINK_REQUIRED","Sign in using your existing method to link a new identity.");
  const secret = token();
  await db.query(`insert into pending_registrations(token_hash,email,provider,issuer,subject,browser_hash,expires_at)
    values($1,$2,$3,$4,$5,$6,now()+interval '20 minutes')`,[hash(secret),email,provider,issuer,subject,hash(browser)]);
  return {state:"onboarding" as const,secret,kind:"customer"};
}
export type OtpPurpose = "signin" | "register" | "link" | "change_email" | "recovery" | "reauth";

export async function startOtp(email: string, browser: string, verifiedIdentity?: Identity, purpose: OtpPurpose = "signin") {
  const normalized = email.trim().toLowerCase();
  const browserHash = hash(browser);
  const otp = randomInt(0,1000000).toString().padStart(6,"0");
  const challengeId = uuid();
  const demo = isDemo() && normalized.endsWith("@qcw.test");
  const mail = postmarkSettings();
  guard(demo || mail.enabled,"EMAIL_UNAVAILABLE","Email verification is unavailable.",503);
  await transaction(async (db) => {
    await lock(db,"otp:" + normalized);
    const budget = await one<{email_count:number;browser_count:number;failed_attempts:number;next_gen:number}>(db,`
      select
        count(*) filter (where target_email=$1)::int as email_count,
        count(*) filter (where browser_binding_hash=$2)::int as browser_count,
        coalesce(sum(attempts) filter (where target_email=$1 and purpose=$3),0)::int as failed_attempts,
        coalesce(max(generation) filter (where target_email=$1 and purpose=$3),0)::int + 1 as next_gen
      from verification_challenges
      where (target_email=$1 or browser_binding_hash=$2) and expires_at>now()-interval '1 hour'`,
      [normalized,browserHash,purpose]);
    guard(budget.email_count < 5 && budget.browser_count < 20 && budget.failed_attempts < 5,
      "RATE_LIMITED","Please wait before requesting another code.",429);
    await db.query(`update verification_challenges set consumed_at=now()
      where browser_binding_hash=$1 and target_email=$2 and purpose=$3 and consumed_at is null`,[browserHash,normalized,purpose]);
    const digest = createHmac("sha256",pepper()).update(`${challengeId}:${purpose}:${otp}`).digest("hex");
    await db.query(`insert into verification_challenges(id,target_email,purpose,browser_binding_hash,code_hmac,expires_at,generation,verified_identity)
      values($1,$2,$3,$4,$5,now()+interval '10 minutes',$6,$7)`,[challengeId,normalized,purpose,browserHash,digest,budget.next_gen,verifiedIdentity ?? null]);
  });
  if (!demo) {
    const submitted = await fetch("https://api.postmarkapp.com/email", {
      method:"POST",
      headers:{"accept":"application/json","content-type":"application/json","X-Postmark-Server-Token":mail.token!},
      body:JSON.stringify({From:mail.from,To:normalized,Subject:"Your QC Warehouse verification code",
        TextBody:`Your code is ${otp}. It expires in 10 minutes.`,MessageStream:mail.stream}),
      signal:AbortSignal.timeout(10000),
    }).then(async response=>{
      if(!response.ok) return false;
      const result=await response.json();
      return result?.ErrorCode===0 && typeof result.MessageID==="string" && result.MessageID.length>0;
    }).catch(()=>false);
    if(!submitted) {
      await pool.query("update verification_challenges set consumed_at=now() where id=$1 and consumed_at is null",[challengeId]);
      guard(false,"EMAIL_UNAVAILABLE","The verification email could not be submitted. Request a new code.",503);
    }
  }
  return {challenge_id:challengeId,resend_after:60,...(demo ? {demo_code:otp} : {})};
}
export async function verifyOtp(challengeId: string, otp: string, browser: string, purpose: OtpPurpose = "signin") {
  const browserHash = hash(browser);
  const result = await transaction(async db => {
    const target = (await db.query<{target_email:string}>("select target_email::text from verification_challenges where id=$1",[challengeId])).rows[0];
    if (!target) return null;
    await lock(db,"otp:" + target.target_email.toLowerCase());
    const c = (await db.query(`select *, expires_at>now() valid from verification_challenges where id=$1 and purpose=$2
      and browser_binding_hash=$3 and consumed_at is null for update`,[challengeId,purpose,browserHash])).rows[0];
    if (!c?.valid || c.attempts >= 5) return null;
    const total = await one<{failed:number}>(db,`select coalesce(sum(attempts),0)::int as failed from verification_challenges
      where target_email=$1 and purpose=$2 and expires_at>now()-interval '1 hour'`,[c.target_email,purpose]);
    if (total.failed >= 5) {
      await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
      return null;
    }
    const digest = createHmac("sha256",pepper()).update(`${challengeId}:${purpose}:${otp}`).digest();
    if (!timingSafeEqual(digest,Buffer.from(c.code_hmac,"hex"))) {
      const nextAttempts = Number(c.attempts) + 1;
      const exhausted = nextAttempts >= 5 || total.failed + 1 >= 5;
      await db.query("update verification_challenges set attempts=$2,consumed_at=case when $3 then now() else consumed_at end where id=$1",
        [challengeId,nextAttempts,exhausted]);
      return null;
    }
    await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
    try {
      return await signInIdentity(db,c.verified_identity ?? {provider:"email_otp",issuer:"qcwarehouse",subject:"",email:c.target_email},browser,!c.verified_identity);
    } catch (error) {
      // A verified code remains consumed when the account or identity is denied.
      if(error instanceof Problem) return error;
      throw error;
    }
  });
  guard(result,"OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  if(result instanceof Problem) throw result;
  return result;
}
export async function currentTerms(db: DB, kinds: string[]) {
  return (await db.query<{id:string;kind:string;version:string;content_md:string;effective_at:Date}>(`select distinct on(kind) id,kind,version,content_md,effective_at
    from terms_versions where kind=any($1) and effective_at<=now() order by kind,effective_at desc,id`,[kinds])).rows;
}
export async function publicPolicy(db:DB,kind:string,version:string|null) {
  if(version===null) {
    const [current]=await currentTerms(db,[kind]);
    guard(current,"NOT_FOUND","No current version of this policy is available.",404);
    return current;
  }
  return one(db,`select id,kind,version,content_md,effective_at from terms_versions
    where kind=$1 and version=$2 and effective_at<=now()`,[kind,version]);
}
export function requireTerms(actual: {id:string}[], submitted: string[], count: number) {
  guard(actual.length===count && submitted.length===count && actual.every(t=>submitted.includes(t.id)),"TERMS_CHANGED","Review the current terms before continuing.");
}
export async function receiving(db: DB, userId: string) {
  const profile = await one<{org_id:string;receiving_code:string}>(db,"select org_id,receiving_code from customer_receiving_profiles where user_id=$1",[userId]);
  const address = (await db.query(`select id,contact_name || ' ' || $1 as recipient,contact_phone as phone,address_zh,address_en
    from warehouse_addresses where is_default and active`,[profile.receiving_code])).rows[0] ?? null;
  return {user_id:userId,...profile,warehouse_address_status:address ? "available" : "pending",warehouse_address:address};
}
export async function completeRegistration(secret:string,browser:string,termsIds:string[]) {
  return transaction(async db=>{
    const tokenHash=hash(secret);
    const pending = await one<Identity & {completed_user_id:string|null}>(db,`select * from pending_registrations
      where token_hash=$1 and browser_hash=$2 and expires_at>now() for update`,[tokenHash,hash(browser)]);
    await lockIdentity(db,pending);
    if(pending.provider!=="email_otp") await lock(db,"email:"+pending.email);
    if(!pending.completed_user_id) requireTerms(await currentTerms(db,["terms","privacy"]),termsIds,2);
    const account=await findIdentityAccount(db,pending);
    if(account) {
      requireActiveIdentity(account);
      guard(!account.staff && (!pending.completed_user_id || pending.completed_user_id===account.id),
        "ACCOUNT_UNAVAILABLE","This registration cannot be resumed.",403);
      await db.query("update pending_registrations set completed_user_id=$2 where token_hash=$1",[tokenHash,account.id]);
      return {profile:await receiving(db,account.id),secret:await session(db,account.id,"customer")};
    }
    guard(!pending.completed_user_id,"ACCOUNT_UNAVAILABLE","This registration cannot be resumed.",403);
    guard(!(await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[pending.email])).rowCount,
      "IDENTITY_LINK_REQUIRED","This email is already registered.");
    const userId=uuid(),orgId=uuid();
    await db.query("insert into users(id,display_name) values($1,$2)",[userId,pending.email.split("@")[0]]);
    await db.query("insert into organizations(id,name) values($1,$2)",[orgId,"Personal workspace"]);
    await db.query("insert into memberships(user_id,org_id) values($1,$2)",[userId,orgId]);
    await db.query("insert into customer_receiving_profiles(user_id,org_id,receiving_code) values($1,$2,$3)",[userId,orgId,code("QCW-")]);
    const email=await one<{id:string}>(db,`insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
      values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,[userId,pending.email]);
    await addEmailOtpIdentity(db,userId,email.id);
    if (pending.provider!=="email_otp") {
      await db.query("insert into auth_identities(user_id,provider,issuer,subject,status,linked_at) values($1,$2,$3,$4,'active',now())",[userId,pending.provider,pending.issuer,pending.subject]);
    }
    await db.query("insert into account_consents(user_id,terms_version_id,accepted_at,source) select $1,unnest($2::uuid[]),now(),'registration'",[userId,termsIds]);
    await db.query("update pending_registrations set completed_user_id=$2 where token_hash=$1",[tokenHash,userId]);
    await audit(db,{id:userId,org:orgId,kind:"customer",roles:[]},"register","users",userId);
    const profile=await receiving(db,userId);
    await event(db,"account.registered",{org_id:orgId,warehouse_address_status:profile.warehouse_address_status});
    return {profile,secret:await session(db,userId,"customer")};
  });
}

function seal(value:string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",Buffer.from(hash(pepper()),"hex"),iv);
  const data = Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]);
}
function unseal(value:Buffer) {
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(hash(pepper()),"hex"),value.subarray(0,12));
  decipher.setAuthTag(value.subarray(12,28));
  return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString();
}
async function providerConfig(provider:OidcProvider) {
  const {clientId,clientSecret,issuer,callback}=oidcSettings(provider);
  guard(clientId && clientSecret && callback,"PROVIDER_UNAVAILABLE","This sign-in method is not configured.",503);
  const config=await oidc.discovery(new URL(issuer),clientId,clientSecret);
  return {config,callback};
}
export async function startProvider(provider:OidcProvider,browser:string,returnPath:string|null) {
  const {config,callback}=await providerConfig(provider);
  const verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce();
  await pool.query(`insert into auth_transactions(state_digest,provider,intent,browser_binding_hash,nonce_digest,verifier_ciphertext,return_path,expires_at)
    values($1,$2,'signin',$3,$4,$5,$6,now()+interval '10 minutes')`,[hash(state),provider,hash(browser),hash(nonce),seal(JSON.stringify({verifier,nonce})),returnPath]);
  return oidc.buildAuthorizationUrl(config,{
    redirect_uri:callback,scope:"openid email profile",
    state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:"S256",
  }).href;
}
export async function finishProvider(provider:OidcProvider,url:URL,browser:string) {
  const state=url.searchParams.get("state") ?? "";
  const tx=await one<{verifier_ciphertext:Buffer;return_path:string|null}>(pool as unknown as DB,`update auth_transactions set consumed_at=now()
    where state_digest=$1 and provider=$2 and intent='signin' and browser_binding_hash=$3 and consumed_at is null and expires_at>now()
    returning verifier_ciphertext,return_path`,[hash(state),provider,hash(browser)]);
  const next=tx.return_path;
  if(url.searchParams.has("error")) return {state:"cancelled" as const,next};
  try {
    const result=await verifyProviderIdentity(provider,url,browser,state,tx.verifier_ciphertext);
    return {...result,next};
  } catch(error) {
    return {state:error instanceof Problem&&error.code==="IDENTITY_LINK_REQUIRED"?"link_required" as const:"failed" as const,next};
  }
}

async function verifyProviderIdentity(provider:OidcProvider,url:URL,browser:string,state:string,encrypted:Buffer) {
  const {verifier,nonce}=JSON.parse(unseal(encrypted));
  const {config,callback}=await providerConfig(provider);
  const redirect=new URL(callback+url.search);
  const result=await oidc.authorizationCodeGrant(config,redirect,{pkceCodeVerifier:verifier,expectedState:state,expectedNonce:nonce,idTokenExpected:true});
  const claims=result.claims();
  guard(claims?.sub && claims.iss,"PROVIDER_IDENTITY_INVALID","Verified provider identity missing.",400);
  if(provider==="microsoft") {
    const personalTenant="9188040d-6c67-4c5b-b112-36a304b66dad";
    guard(claims.tid===personalTenant && claims.iss===`https://login.microsoftonline.com/${personalTenant}/v2.0`,
      "PROVIDER_IDENTITY_INVALID","Use a personal Microsoft account.",400);
  }
  const email=typeof claims.email==="string" ? claims.email.trim().toLowerCase() : "";
  const identity={provider,issuer:claims.iss,subject:claims.sub,email};
  if (provider==="google" && claims.email_verified===true && email) {
    return transaction(db=>signInIdentity(db,identity,browser));
  }
  const linked=(await pool.query("select 1 from auth_identities where provider=$1 and issuer=$2 and subject=$3 and status='active'",[provider,claims.iss,claims.sub])).rowCount;
  if (linked) return transaction(db=>signInIdentity(db,identity,browser));
  const pending=seal(JSON.stringify({identity,browserHash:hash(browser),expires:Date.now()+900000})).toString("base64url");
  return {state:"verify_email" as const,secret:pending,kind:"customer"};
}
export function pendingProvider(value:string,email:string,browser:string): Identity | undefined {
  if (!value) return undefined;
  try {
    const pending=JSON.parse(unseal(Buffer.from(value,"base64url"))) as {identity:Identity;browserHash:string;expires:number};
    if(pending.expires>Date.now() && pending.browserHash===hash(browser)) {
      return {...pending.identity,email:email.trim().toLowerCase()};
    }
  } catch {
    // Treat unreadable or old-format cookies like expired verification state.
  }
  guard(false,"PROVIDER_VERIFICATION_EXPIRED","Restart provider sign-in or continue with email.",400);
}
export function passwordHash(password:string) {
  const salt=token();
  return salt+":"+scryptSync(password,salt,64).toString("hex");
}
export async function staffSignIn(email:string,password:string,otp:string) {
  return transaction(async db=>{
    const key="staff:"+email.toLowerCase();
    await lock(db,key);
    const recent=await one<{n:number}>(db,"select count(*)::int n from account_security_events where kind=$1 and occurred_at>now()-interval '15 minutes'",[hash(key)]);
    guard(recent.n<8,"RATE_LIMITED","Too many sign-in attempts.",429);
    const user=(await db.query(`select u.* from users u join user_emails e on e.user_id=u.id
      where e.normalized_email=$1 and u.status='active' and exists(select 1 from staff_roles where user_id=u.id)`,[email])).rows[0];
    const [salt,digest]=(user?.password_hash ?? "invalid:"+"0".repeat(128)).split(":");
    const verified=timingSafeEqual(scryptSync(password,salt,64),Buffer.from(digest,"hex"));
    let otpOK=false;
    if (verified && user?.mfa_secret_enc && /^\d{6}$/.test(otp)) {
      const secret=unseal(Buffer.from(user.mfa_secret_enc,"base64url"));
      const counter=Math.floor(Date.now()/30000);
      for (const offset of [-1,0,1]) {
        const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter+offset));
        const h=createHmac("sha1",Buffer.from(secret,"hex")).update(bytes).digest();
        const number=(h.readUInt32BE(h[19]&15)&0x7fffffff)%1000000;
        if (String(number).padStart(6,"0")===otp) {
          const used=await db.query("insert into idempotency_keys(scope,key,request_hash) values($1,$2,'totp') on conflict do nothing",["mfa:"+user.id,String(counter+offset)]);
          otpOK=!!used.rowCount;
          break;
        }
      }
    }
    if (!verified || !otpOK || !user) {
      await db.query("insert into account_security_events(user_id,kind,outcome,request_id) values($1,$2,'denied',$3)",[user?.id??null,hash(key),uuid()]);
      return null;
    }
    return session(db,user.id,"staff",true);
  });
}
export { seal as encryptSecret };
export { unseal as decryptSecret };
