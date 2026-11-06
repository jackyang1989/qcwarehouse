"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { SignInMethods } from "../packages/core/integrations";
import { staffDestination, staffHome, withDestination } from "../packages/core/portal-routes";
import { Brand } from "./chrome";
import { ErrorBlock, Form, request, text, useLoad } from "./ui";

const oauthMessages:Record<string,string>={
  cancelled:"Sign-in was cancelled. Choose a sign-in method to continue.",
  failed:"We could not complete provider sign-in. Try again or use email.",
  link_required:"This email already has an account. Sign in using your existing method to access it.",
};

export function AccessShell({staff,children}:{staff:boolean;children:ReactNode}) {
  return <div className="access-page" lang={staff?"zh-CN":"en"}>
    <header className="access-header"><Brand/><Link href="/">{staff?"返回官网":"Back to website"}</Link></header>
    <main className="access-main" id="main-content">{children}</main>
    <footer className="access-footer"><Link href="/legal/privacy">{staff?"隐私政策":"Privacy"}</Link>
      <Link href="/contact">{staff?"联系支持":"Contact support"}</Link></footer>
  </div>;
}

type Challenge={challenge_id:string;demo_code?:string};
type SignInResult={kind:"staff"|"customer";state:"onboarding"|"signed_in"};

export function Login({staff,methods,next,verify,oauth}:{
  staff:boolean;methods:SignInMethods;next:string|null;verify:boolean;oauth?:string;
}) {
  const [challenge,setChallenge]=useState<Challenge>();
  const [email,setEmail]=useState("");
  const [showEmail,setShowEmail]=useState(verify||methods.demo||!methods.google&&!methods.microsoft);
  const emailAvailable=methods.email||methods.demo;

  async function after(result:SignInResult) {
    if(result.kind==="staff") {
      const {actor}=await request("/me");
      const preferred=next?.startsWith("/wh")?"warehouse":"admin";
      location.assign(staffDestination(next,actor.roles)??staffHome(actor.roles,preferred)??"/staff/login");
      return;
    }
    location.assign(result.state==="onboarding"?withDestination("/onboarding",staff?null:next):staff?"/account":next??"/account");
  }

  async function sendCode(address:string) {
    setChallenge(await request("/auth/otp/request","POST",{email:address}));
    setEmail(address);
  }

  return <section className="panel access-card" aria-labelledby="access-title">
    <p className="eyebrow">{staff?"QCWarehouse 员工工作区":"QCWarehouse customer account"}</p>
    <h1 id="access-title">{staff?"员工登录":"Sign in or create an account"}</h1>
    <p className="muted">{staff?"登录后进入已获授权的仓库或运营页面。":"Sign in to open your workspace. New customers get a personal warehouse receiving code after registration."}</p>
    {!staff&&next&&<p className="notice">You’ll return to your requested page after signing in.</p>}
    {!staff&&oauth&&Object.hasOwn(oauthMessages,oauth)&&<ErrorBlock error={oauthMessages[oauth]}/>}
    {!staff&&verify&&<p className="notice">Verify your contact email to finish provider sign-in.</p>}
    {!staff&&!challenge&&<div className="sign-in-methods">
      {(["google","microsoft"] as const).map(provider=>{
        const label=provider==="google"?"Google":"Microsoft";
        return methods[provider]?<a className="button" key={provider} href={withDestination("/api/v1/auth/"+provider+"/start",next)}>Continue with {label}</a>:
          <div className="sign-in-unavailable" key={provider}><span>{label}</span><small>Currently unavailable</small></div>;
      })}
      {!showEmail&&emailAvailable&&<button type="button" onClick={()=>setShowEmail(true)}>Continue with email</button>}
    </div>}
    {methods.demo&&<p className="notice">{staff?"本地测试环境。可使用员工密码+TOTP验证器登录，或使用下方 @qcw.test 测试验证码快捷登录。":"Local test environment. Use an @qcw.test address to get a test code on this page."}</p>}
    {staff&&<Form label="密码与验证器登录" run={async f=>after(await request("/staff/auth/login","POST",{
      email:text(f,"email"),password:String(f.get("password")??""),otp:text(f,"otp"),
    }))}>
      <label>员工邮箱<input name="email" type="email" autoComplete="username" required/></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required/></label>
      <label>验证器动态码<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
    </Form>}
    {emailAvailable&&(staff&&methods.demo||!staff&&showEmail)&&(challenge?
      <div className="code-step">
        <p>{staff?"测试账号":challenge.demo_code?"Test code for":"Code sent to"} <strong>{email}</strong></p>
        {challenge.demo_code&&<p className="code">{challenge.demo_code}</p>}
        <Form key={challenge.challenge_id} label={staff?"验证并登录":"Verify code"} run={async f=>after(await request("/auth/otp/verify","POST",{
          challenge_id:challenge.challenge_id,code:text(f,"code"),
        }))}>
          <label>{staff?"验证码":"Verification code"}<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
        </Form>
        <button type="button" onClick={()=>setChallenge(undefined)}>{staff?"更换邮箱或重新获取验证码":"Change email or request another code"}</button>
      </div>:<Form label={methods.demo?(staff?"获取测试验证码":"Get test code"):"Email me a verification code"} run={f=>sendCode(text(f,"email"))}>
        <label>{staff?"测试员工邮箱 (@qcw.test)":"Email address"}<input name="email" type="email" autoComplete="email" defaultValue={email} required/></label>
      </Form>)}
    {!staff&&!emailAvailable&&<p className="muted small">Email codes are currently unavailable. <Link href="/contact">Contact support</Link> if you need account access.</p>}
    {!staff&&<p className="small"><Link href="/account/recovery">Lost access to your sign-in method? Request account recovery</Link></p>}
  </section>;
}

export function AccountRecovery() {
  const [challenge,setChallenge]=useState<Challenge>();
  const [targetEmail,setTargetEmail]=useState("");
  const [submitted,setSubmitted]=useState<{request_id:string;status_token:string;state:string}>();
  const [statusResult,setStatusResult]=useState<{request_id:string;state:string;executable_after?:string|null;executed_at?:string|null}>();

  return <section className="panel access-card" aria-labelledby="access-title">
    <p className="eyebrow">QCWarehouse account security</p>
    <h1 id="access-title">Account recovery</h1>
    <p className="muted">If you lost access to your sign-in method, verify a new email address and provide account ownership details for dual-control security review.</p>
    {!submitted&&(challenge?
      <div className="code-step">
        <p>{challenge.demo_code?"Test code for":"Code sent to"} <strong>{targetEmail}</strong></p>
        {challenge.demo_code&&<p className="code">{challenge.demo_code}</p>}
        <Form key={challenge.challenge_id} label="Submit recovery request" run={async f=>{
          const res=await request("/auth/recovery/request","POST",{
            challenge_id:challenge.challenge_id,
            code:text(f,"code"),
            previous_email:text(f,"previous_email"),
            details:text(f,"details"),
          });
          setSubmitted(res);
        }}>
          <label>Verification code for new email<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
          <label>Previous account email<input name="previous_email" type="email" required/></label>
          <label>Ownership evidence (receiving code, order numbers, or payment receipts)<textarea name="details" required minLength={4} maxLength={2000}/></label>
        </Form>
        <button type="button" onClick={()=>setChallenge(undefined)}>Use a different new email</button>
      </div>:
      <Form label="Send verification code to new email" run={async f=>{
        const address=text(f,"target_email");
        setChallenge(await request("/auth/otp/request","POST",{email:address,purpose:"recovery"}));
        setTargetEmail(address);
      }}>
        <label>New email address to bind after recovery<input name="target_email" type="email" autoComplete="email" defaultValue={targetEmail} required/></label>
      </Form>)}
    {submitted&&<div className="notice" role="status">
      <p><strong>Recovery request submitted.</strong> Save your request ID and status token to check progress.</p>
      <p>Request ID: <span className="code">{submitted.request_id}</span></p>
      <p>Status token: <span className="code">{submitted.status_token}</span></p>
    </div>}
    <details className="top-gap" open={Boolean(submitted)}>
      <summary>Check recovery request status</summary>
      <Form label="Check status" run={async f=>{
        const reqId=text(f,"request_id"),tok=text(f,"token");
        setStatusResult(await request("/auth/recovery/status?"+new URLSearchParams({request_id:reqId,token:tok})));
      }}>
        <label>Request ID<input name="request_id" defaultValue={submitted?.request_id??""} required/></label>
        <label>Status token<input name="token" defaultValue={submitted?.status_token??""} required/></label>
      </Form>
      {statusResult&&<div className="notice" role="status">
        <p>Status: <strong>{statusResult.state}</strong></p>
        {statusResult.executable_after&&<p>Cooldown ends: {statusResult.executable_after}</p>}
        {statusResult.executed_at&&<p>Completed at: {statusResult.executed_at}</p>}
      </div>}
    </details>
    <p className="small"><Link href="/login">Return to sign in</Link></p>
  </section>;
}

export function Onboarding({next}:{next:string|null}) {
  const {data,error,reload}=useLoad("/public/terms");
  const terms=(data?.terms??[]).filter((t:{kind:string})=>t.kind==="terms"||t.kind==="privacy");
  return <section className="panel access-card" aria-labelledby="access-title">
    <p className="eyebrow">QCWarehouse customer account</p>
    <h1 id="access-title">Activate your receiving address</h1><p className="muted">Review the account terms to get your permanent receiving code.</p>
    {!data&&!error&&<p role="status">Loading account terms…</p>}
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
    {data&&terms.length!==2&&<p role="alert">Account terms are unavailable. <Link href="/contact">Contact support</Link> to continue.</p>}
    {terms.length===2&&<Form label="Create my account" run={async f=>{
      if(f.get("accept")!=="on") throw new Error("Accept both policies to continue.");
      await request("/auth/registration/complete","POST",{terms_version_ids:terms.map((t:{id:string})=>t.id)});
      location.assign(withDestination("/account",next));
    }}>
      {terms.map((t:{id:string;kind:string;version:string;content_md:string})=><details key={t.id}>
        <summary>{t.kind==="terms"?"Terms of service":"Privacy notice"} · {t.version}</summary><p className="policy-content">{t.content_md}</p></details>)}
      <label className="check"><input type="checkbox" name="accept" required/> I accept the terms of service and privacy notice.</label>
    </Form>}
    <p className="small"><Link href={withDestination("/login",next)}>Return to sign in</Link></p>
  </section>;
}
