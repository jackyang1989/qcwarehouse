import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { savePhoto } from "./intake";
import { hasStaffAccess, staffAccess } from "./staff-access";

const body=z.string().trim().min(2).max(2000);
const version=z.number().int().positive();
const publicInquiryLimit=5;
export const publicInquiry=z.object({
  email:z.string().trim().toLowerCase().pipe(z.email().max(254)),
  category_id:z.uuid(),sample_count:z.number().int().positive().max(2147483647),
  description:z.string().trim().min(1).max(1000),
});
export const customerTicketMessage=z.object({revision:version,body});
export const staffTicketEvent=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("claim"),revision:version}),
  z.object({kind:z.literal("reply"),revision:version,body,reply_by:z.iso.datetime().optional()}),
  z.object({kind:z.literal("internal_note"),revision:version,body}),
  z.object({kind:z.literal("resolve"),revision:version,body}),
]);

export async function inquiryCategories(db:DB) {
  return (await db.query(`select id,labels->>'en' label from categories
    where status in ('ACTIVE','PLANNED') and nullif(labels->>'en','') is not null order by label,id`)).rows;
}
export async function createPublicInquiry(db:DB,actor:Actor|null,browser:string,input:z.infer<typeof publicInquiry>) {
  const org=actor?organization(actor):null;
  const {email,category_id,sample_count,description}=input;
  const emailKey=hash(email),browserKey=hash(browser);
  await lock(db,"public-inquiry:email:"+emailKey);
  await lock(db,"public-inquiry:browser:"+browserKey);
  const {by_email,by_browser}=await one<{by_email:number;by_browser:number}>(db,`select
    count(*) filter (where details->>'email_key'=$1)::int by_email,
    count(*) filter (where details->>'browser_key'=$2)::int by_browser
    from tickets where category='non_standard_quote' and created_at>=now()-interval '1 hour'
    and (details->>'email_key'=$1 or details->>'browser_key'=$2)`,[emailKey,browserKey]);
  guard(by_email<publicInquiryLimit&&by_browser<publicInquiryLimit,"INQUIRY_RATE_LIMIT","Too many inquiries. Try again later.",429);
  const category=(await db.query(`select labels from categories where id=$1 and status in ('ACTIVE','PLANNED')
    and nullif(labels->>'en','') is not null for share`,[category_id])).rows[0];
  guard(category,"INQUIRY_CATEGORY_UNAVAILABLE","Select an available category.",422);
  const id=uuid(),public_no=code("C-");
  await db.query(`insert into tickets(id,public_no,org_id,category,subject,details,next_action_at)
    values($1,$2,$3,'non_standard_quote','Custom inspection inquiry',$4,now()+interval '24 hours')`,
    [id,public_no,org,{public_inquiry:true,contact_email:email,category_id,category_labels:category.labels,sample_count,
      email_key:emailKey,browser_key:browserKey}]);
  await append(db,actor,id,"message",description);
  return {public_no,...(org?{case_id:id}:{})};
}

async function ticket(db:DB,actor:Actor,id:string,orderNumber:string|null,write=false) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null)role(actor,...staffAccess.orders);
  return one(db,`select k.id,k.org_id,k.public_no,k.subject,k.category,k.state,k.revision,k.next_action_at,k.assignee_id,
    u.display_name assignee,o.public_no order_number,k.details
    from tickets k left join orders o on o.id=k.order_id and o.org_id=k.org_id left join users u on u.id=k.assignee_id
    where k.id=$1 and ($2::uuid is null or k.org_id=$2) and ($3::text is null or o.public_no=$3)${write?" for update of k":""}`,
    [id,org,orderNumber]);
}
export async function caseDetail(db:DB,actor:Actor,id:string,orderNumber:string|null) {
  const k=await ticket(db,actor,id,orderNumber);
  const {rows:events}=await db.query(`select id,actor_type,kind,body,media_ids,created_at from ticket_events
    where ticket_id=$1 and ($2::boolean or kind='message') order by created_at,id`,[id,actor.kind==="staff"]);
  const recovery=actor.kind==="staff"?(await db.query(`select r.id,r.user_id,r.state,r.requested_by as support_reviewer_id,
    r.approved_by as admin_approver_id,r.execute_after as executable_after,r.executed_at,p.receiving_code,u.status as user_status
    from recovery_requests r left join users u on u.id=r.user_id left join customer_receiving_profiles p on p.user_id=u.id
    where r.evidence_ticket_id=$1 order by r.verified_at desc nulls last limit 1`,[id])).rows[0]??null:null;
  return {id:k.id,public_no:k.public_no,subject:k.subject,category:k.category,state:k.state,revision:k.revision,
    next_action_at:k.next_action_at,order_number:k.order_number,
    ...(actor.kind==="staff"?{assignee_id:k.assignee_id,assignee:k.assignee,account_recovery:recovery,
      ...(k.details.public_inquiry?{inquiry:{contact_email:k.details.contact_email,category:k.details.category_labels,
        sample_count:k.details.sample_count,portal_reply:!!k.org_id}}:{})}:{}),events};
}
export async function canReadCasePhoto(db:DB,actor:Actor,id:string) {
  const staff=actor.kind==="staff"&&hasStaffAccess(actor.roles,staffAccess.orders);
  const org=actor.kind==="customer"?organization(actor):null;
  if(!staff&&!org)return false;
  const match=await db.query(`select 1 from ticket_events e join tickets k on k.id=e.ticket_id
    where $1=any(e.media_ids) and ($2::boolean or k.org_id=$3 and e.kind='message') limit 1`,[id,staff,org]);
  return !!match.rowCount;
}
export async function staffTicketQueue(db:DB,actor:Actor,state:string|null,reference:string|null) {
  role(actor,...staffAccess.orders);
  const {rows}=await db.query(`select k.id,k.public_no,k.subject,k.category,k.state,k.next_action_at,k.created_at,u.display_name assignee,o.public_no order_number
    from tickets k left join users u on u.id=k.assignee_id left join orders o on o.id=k.order_id and o.org_id=k.org_id
    where ($1::text is null or k.state=$1) and ($2::text is null or k.public_no=$2)
    order by k.next_action_at nulls last,k.created_at desc,k.id limit 100`,[state,reference]);
  return {rows};
}
async function append(db:DB,actor:Actor|null,id:string,kind:string,message:string,mediaIds:string[]=[]){
  const eventId=uuid();
  await db.query("insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body,media_ids) values($1,$2,$3,$4,$5,$6,$7)",
    [eventId,id,actor?.kind??"customer",actor?.id??null,kind,message,mediaIds]);
  await audit(db,actor,"ticket_"+kind,"tickets",id,{event_id:eventId});
}
function ensureOpen(state:string) {
  guard(!["resolved","closed"].includes(state),"CASE_CLOSED","This support case is closed.");
}
export async function replyToCase(db:DB,actor:Actor,id:string,input:z.infer<typeof customerTicketMessage>,photo?:Buffer) {
  organization(actor);
  const k=await ticket(db,actor,id,null,true);
  revision(k.revision,input.revision);
  ensureOpen(k.state);
  const media=photo?[ (await savePhoto(db,actor,photo,"attachment")).id ]:[];
  await append(db,actor,id,"message",input.body,media);
  await db.query(`update tickets set state='waiting_internal',next_action_at=now()+interval '24 hours',revision=revision+1 where id=$1`,[id]);
  return {id,state:"waiting_internal",revision:k.revision+1};
}
export async function writeStaffTicket(db:DB,actor:Actor,id:string,input:z.infer<typeof staffTicketEvent>) {
  role(actor,...staffAccess.orders);
  const k=await ticket(db,actor,id,null,true);
  revision(k.revision,input.revision);
  ensureOpen(k.state);
  let state=k.state,assignee=k.assignee_id,due=k.next_action_at;
  if(input.kind==="claim") {
    guard(!assignee||assignee===actor.id,"CASE_ASSIGNED","This case is already assigned to another employee.");
    if(assignee===actor.id)return {id,state,revision:k.revision};
    assignee=actor.id;
    await append(db,actor,id,"state_change","Assigned to current employee.");
  } else {
    guard(assignee===actor.id||actor.roles.includes("super_admin"),"CASE_ASSIGNED","Claim this case before making changes.");
    if(input.kind==="resolve") {
      guard(k.category!=="identity_unclear","CLAIM_DECISION_REQUIRED","Use the separate parcel ownership decision.");
      state="resolved";due=null;
      await append(db,actor,id,"internal_note",input.body);
    } else if(input.kind==="internal_note") {
      await append(db,actor,id,"internal_note",input.body);
    } else {
      guard(!k.details.public_inquiry||k.org_id,"CASE_CONTACT_REQUIRED","Contact the guest using the inquiry email and record the follow-up internally.");
      guard(!input.reply_by||new Date(input.reply_by)>new Date(),"INVALID_DEADLINE","Choose a future reply deadline.",422);
      state=input.reply_by?"waiting_customer":"waiting_internal";
      due=input.reply_by??null;
      await append(db,actor,id,"message",input.body);
      if(k.org_id)await event(db,"ticket.reply",{ticket_id:id,org_id:k.org_id});
    }
  }
  await db.query(`update tickets set state=$2,assignee_id=$3,next_action_at=$4,revision=revision+1,
    resolved_at=case when $2='resolved' then now() else resolved_at end where id=$1`,[id,state,assignee,due]);
  return {id,state,revision:k.revision+1};
}
