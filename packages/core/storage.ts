import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { staffAccess } from "./staff-access";

const occupied = "w.custody_state in ('received','stored')";
export const storageZones = z.enum(["receiving","queue","inspecting","post_inspection","reference","unmatched","quarantine"]);
const slot = z.number().int().min(1).max(99);
export const locationBatchSchema = z.object({
  prefix:z.string().regex(/^[A-Z]$/),zone:storageZones,rack:slot,level:slot,start:slot,end:slot,
  capacity:z.number().int().min(1).max(999),notes:z.string().trim().max(200).optional(),
}).refine(input=>input.start<=input.end,"The slot range must be in ascending order.");

export async function assertItemNotFrozen(db:DB,itemIds:string[],errorCode="ITEM_FROZEN") {
  if(!itemIds.length) return;
  const stocktakeFrozen=(await db.query(
    `select si.item_id from stocktake_items si join stocktakes st on st.id=si.stocktake_id
     where si.item_id=any($1::uuid[]) and si.state='investigating' and st.state in ('in_progress','submitted') limit 1`,
    [itemIds]
  )).rowCount;
  guard(!stocktakeFrozen,errorCode,"An item is frozen pending stocktake discrepancy investigation.");
  const incidentFrozen=(await db.query(
    `select ic.item_id from incident_cases ic
     where ic.item_id=any($1::uuid[]) and ic.state not in ('resolved','closed') limit 1`,
    [itemIds]
  )).rowCount;
  guard(!incidentFrozen,errorCode,"An item is frozen due to an active warehouse incident case.");
}

async function lockedLocation(db:DB,id:string) {
  const location=await one<{active:boolean;capacity:number|null}>(db,"select active,capacity from storage_locations where id=$1 for update",[id]);
  const count=await one<{n:number}>(db,`select count(*)::int n from warehouse_items w where w.location_id=$1 and ${occupied}`,[id]);
  return {...location,occupied:count.n};
}
export async function requireSpace(db:DB,id:string,quantity:number) {
  const location=await lockedLocation(db,id);
  guard(location.active,"LOCATION_INACTIVE","This storage location is disabled.");
  guard(location.capacity===null||location.occupied+quantity<=location.capacity,"LOCATION_FULL","This storage location does not have enough free space.");
}
export async function locationMaster(db:DB,actor:Actor) {
  role(actor,...staffAccess.locations);
  const {rows}=await db.query(`select l.id,l.code,l.zone,l.active,l.capacity,l.notes,
    (select count(*)::int from warehouse_items w where w.location_id=l.id and ${occupied}) occupied
    from storage_locations l order by l.code`);
  return {rows};
}
export async function createLocations(db:DB,actor:Actor,input:z.infer<typeof locationBatchSchema>) {
  role(actor,...staffAccess.locations);
  const codes=Array.from({length:input.end-input.start+1},(_,i)=>[input.prefix,...[input.rack,input.level,input.start+i].map(n=>String(n).padStart(2,"0"))].join("-"));
  const added:{id:string;code:string}[]=[];
  for(const code of codes) {
    const {rows}=await db.query<{id:string;code:string}>(`insert into storage_locations(id,code,zone,capacity,notes)
      values($1,$2,$3,$4,$5) on conflict(code) do nothing returning id,code`,[uuid(),code,input.zone,input.capacity,input.notes??null]);
    if(rows[0]) {
      added.push(rows[0]);
      await audit(db,actor,"create_storage_location","storage_locations",rows[0].id,{code,zone:input.zone,capacity:input.capacity});
    }
  }
  return {added,skipped:codes.filter(code=>!added.some(row=>row.code===code))};
}
export async function setLocationActive(db:DB,actor:Actor,id:string,active:boolean) {
  role(actor,...staffAccess.locations);
  const location=await lockedLocation(db,id);
  guard(active||!location.occupied,"LOCATION_OCCUPIED","Move the items before disabling this storage location.");
  if(location.active!==active) {
    await db.query("update storage_locations set active=$2 where id=$1",[id,active]);
    await audit(db,actor,"set_storage_location_active","storage_locations",id,{active});
  }
  return {id,active};
}
export async function storageMovementDesk(db:DB,actor:Actor) {
  role(actor,...staffAccess.intake);
  const {rows:locations}=await db.query("select id,code,zone from storage_locations where active order by code");
  const {rows:moves}=await db.query(`select e.id,w.code,origin.code origin,destination.code destination,u.display_name operator,e.created_at
    from storage_events e join warehouse_items w on w.id=e.item_id join users u on u.id=e.operator_id
    left join storage_locations origin on origin.id=e.from_location_id
    left join storage_locations destination on destination.id=e.to_location_id
    where e.action='move' order by e.created_at desc,e.id desc limit 50`);
  return {locations,moves};
}

export async function listStocktakes(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","super_admin");
  const {rows:stocktakes}=await db.query(
    `select s.id,s.scope,s.snapshot_at,s.operator_id,u.display_name operator_name,s.state
     from stocktakes s join users u on u.id=s.operator_id
     order by s.snapshot_at desc limit 30`
  );
  const {rows:items}=await db.query(
    `select si.id,si.stocktake_id,si.item_id,w.code item_code,w.custody_state,
            si.expected_location,el.code expected_location_code,
            si.actual_location,al.code actual_location_code,
            si.revision,si.evidence,si.state,
            ia.id adjustment_id,ia.reason adjustment_reason,ia.requested_by,ia.approved_by
     from stocktake_items si
     join warehouse_items w on w.id=si.item_id
     left join storage_locations el on el.id=si.expected_location
     left join storage_locations al on al.id=si.actual_location
     left join inventory_adjustments ia on ia.stocktake_item_id=si.id
     order by w.code`
  );
  return {
    rows:stocktakes.map(s=>({
      ...s,
      items:items.filter(i=>i.stocktake_id===s.id),
    })),
  };
}

export async function createStocktake(
  db:DB,
  actor:Actor,
  input:{zone?:string;location_ids?:string[];note?:string}
) {
  role(actor,"receiver","warehouse_admin","super_admin");
  let locIds=input.location_ids??[];
  if(!locIds.length && input.zone) {
    locIds=(await db.query<{id:string}>("select id from storage_locations where zone=$1 and active",[input.zone])).rows.map(r=>r.id);
  }
  if(!locIds.length) {
    locIds=(await db.query<{id:string}>("select id from storage_locations where active")).rows.map(r=>r.id);
  }
  guard(locIds.length>0,"LOCATION_REQUIRED","Select at least one active storage location for stocktake.",422);
  const stId=uuid();
  const scope={zone:input.zone??null,location_ids:locIds,note:input.note??null};
  const st=await one<{id:string;snapshot_at:Date;state:string}>(
    db,
    `insert into stocktakes(id,scope,snapshot_at,operator_id,state)
     values($1,$2,now(),$3,'in_progress')
     returning id,snapshot_at,state`,
    [stId,scope,actor.id]
  );
  const expected=(await db.query<{id:string;location_id:string;revision:number}>(
    `select id,location_id,revision from warehouse_items
     where location_id=any($1::uuid[]) and custody_state in ('received','stored') and parent_item_id is null
     order by code`,
    [locIds]
  )).rows;
  for(const item of expected) {
    await db.query(
      `insert into stocktake_items(id,stocktake_id,item_id,expected_location,actual_location,revision,evidence,state)
       values($1,$2,$3,$4,null,$5,'[]'::jsonb,'pending')`,
      [uuid(),stId,item.id,item.location_id,item.revision]
    );
  }
  await audit(db,actor,"create_stocktake","stocktakes",stId,{item_count:expected.length,scope});
  return {
    id:st.id,
    stocktake_id:st.id,
    snapshot_at:st.snapshot_at,
    state:st.state,
    item_count:expected.length,
    item_ids:expected.map(x=>x.id),
  };
}

export async function scanStocktakeItem(
  db:DB,
  actor:Actor,
  stocktakeId:string,
  input:{
    item_id?:string;
    item_code?:string;
    actual_location?:string|null;
    status:"matched"|"relocated"|"missing"|"found";
    note?:string;
    evidence_ids?:string[];
  }
) {
  role(actor,"receiver","warehouse_admin","super_admin");
  const st=await one(db,"select * from stocktakes where id=$1 for update",[stocktakeId]);
  guard(["in_progress","submitted"].includes(st.state),"STOCKTAKE_CLOSED","This stocktake is already closed.");
  const item=input.item_id
    ?await one(db,"select * from warehouse_items where id=$1 for update",[input.item_id])
    :await one(db,"select * from warehouse_items where upper(code)=upper($1) for update",[input.item_code??""]);
  const si=(await db.query(
    "select * from stocktake_items where stocktake_id=$1 and item_id=$2 for update",
    [stocktakeId,item.id]
  )).rows[0];
  guard(si,"ITEM_NOT_IN_STOCKTAKE","This item is not part of the selected stocktake snapshot.",404);

  // T102: Detect concurrent movement or outbound handover after snapshot_at
  const movedAfterSnapshot=(await db.query(
    "select 1 from storage_events where item_id=$1 and created_at>$2 limit 1",
    [item.id,st.snapshot_at]
  )).rowCount;
  if(input.status==="missing" && (item.revision>si.revision || Boolean(movedAfterSnapshot))) {
    const nextExpected=item.custody_state==="outbound"?null:item.location_id;
    const ev=[...(Array.isArray(si.evidence)?si.evidence:[]),{at:new Date().toISOString(),actor_id:actor.id,event:"concurrent_movement_recount",snapshot_revision:si.revision,current_revision:item.revision}];
    await db.query(
      `update stocktake_items set state='recount_required',expected_location=coalesce($2,expected_location),revision=$3,evidence=$4 where id=$1`,
      [si.id,nextExpected,item.revision,JSON.stringify(ev)]
    );
    await audit(db,actor,"stocktake_recount_required","stocktakes",stocktakeId,{item_id:item.id,snapshot_revision:si.revision,current_revision:item.revision});
    return {
      stocktake_item_id:si.id,
      item_id:item.id,
      state:"recount_required",
      recount_required:true,
      current_location_id:item.location_id,
      current_custody_state:item.custody_state,
      current_revision:item.revision,
    };
  }

  const entry={
    at:new Date().toISOString(),
    actor_id:actor.id,
    status:input.status,
    actual_location:input.actual_location??null,
    note:input.note??null,
    evidence_ids:input.evidence_ids??[],
  };
  const nextEvidence=[...(Array.isArray(si.evidence)?si.evidence:[]),entry];

  if(input.status==="matched") {
    const loc=input.actual_location??si.expected_location;
    await db.query(
      "update stocktake_items set actual_location=$2,state='matched',revision=$3,evidence=$4 where id=$1",
      [si.id,loc,item.revision,JSON.stringify(nextEvidence)]
    );
    return {stocktake_item_id:si.id,item_id:item.id,state:"matched",frozen:false};
  }

  if(input.status==="found") {
    const loc=input.actual_location??si.expected_location??item.location_id;
    guard(loc,"LOCATION_REQUIRED","Specify the storage location where the recovered item was found.",422);
    if(item.location_id!==loc) {
      await requireSpace(db,loc,1);
      await db.query("update warehouse_items set location_id=$2,revision=revision+1 where id=$1",[item.id,loc]);
      await db.query("insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'stocktake_recovery',$4)",[item.id,item.location_id,loc,actor.id]);
    }
    await db.query(
      "update stocktake_items set actual_location=$2,state='matched',evidence=$3 where id=$1",
      [si.id,loc,JSON.stringify(nextEvidence)]
    );
    await audit(db,actor,"stocktake_item_recovered","stocktakes",stocktakeId,{item_id:item.id,location_id:loc,note:input.note??null});
    return {stocktake_item_id:si.id,item_id:item.id,state:"matched",frozen:false,recovered:true};
  }

  // status is 'missing' or 'relocated' -> mark 'investigating' to freeze the item (T102)
  const actualLoc=input.status==="missing"?null:(input.actual_location??null);
  if(input.status==="relocated") {
    guard(actualLoc && actualLoc!==si.expected_location,"LOCATION_REQUIRED","Provide the actual storage location for a relocated item.",422);
  }
  await db.query(
    "update stocktake_items set actual_location=$2,state='investigating',evidence=$3 where id=$1",
    [si.id,actualLoc,JSON.stringify(nextEvidence)]
  );
  await audit(db,actor,"stocktake_discrepancy_frozen","stocktakes",stocktakeId,{item_id:item.id,status:input.status,actual_location:actualLoc});
  return {stocktake_item_id:si.id,item_id:item.id,state:"investigating",frozen:true};
}

export async function submitStocktake(db:DB,actor:Actor,stocktakeId:string,input:{reason?:string}) {
  role(actor,"receiver","warehouse_admin","super_admin");
  const st=await one(db,"select * from stocktakes where id=$1 for update",[stocktakeId]);
  guard(st.state==="in_progress","STOCKTAKE_UNAVAILABLE","This stocktake has already been submitted.");
  const items=(await db.query(
    `select si.*,w.custody_state,w.location_id current_location_id
     from stocktake_items si join warehouse_items w on w.id=si.item_id
     where si.stocktake_id=$1 for update of si`,
    [stocktakeId]
  )).rows;
  const unfinished=items.filter(i=>["pending","recount_required"].includes(i.state));
  guard(unfinished.length===0,"STOCKTAKE_INCOMPLETE","Scan or recount all pending items before submitting the stocktake.");
  const discrepancies=items.filter(i=>i.state==="investigating");
  const reason=(input.reason??"Stocktake discrepancy adjustment").trim();
  for(const d of discrepancies) {
    const existing=(await db.query("select id from inventory_adjustments where stocktake_item_id=$1",[d.id])).rows[0];
    if(!existing) {
      await db.query(
        `insert into inventory_adjustments(id,stocktake_item_id,reason,before_state,after_state,requested_by,approved_by)
         values($1,$2,$3,$4,$5,$6,null)`,
        [
          uuid(),
          d.id,
          reason,
          {expected_location:d.expected_location,custody_state:d.custody_state},
          {actual_location:d.actual_location,proposed:d.actual_location?"relocate":"missing_confirmed"},
          actor.id,
        ]
      );
    }
  }
  const nextState=discrepancies.length>0?"submitted":"approved";
  await db.query("update stocktakes set state=$2 where id=$1",[stocktakeId,nextState]);
  await audit(db,actor,"submit_stocktake","stocktakes",stocktakeId,{discrepancies:discrepancies.length,state:nextState});
  return {id:stocktakeId,state:nextState,discrepancy_count:discrepancies.length};
}

export async function approveStocktake(
  db:DB,
  actor:Actor,
  stocktakeId:string,
  input:{decision:"approve"|"recount";reason:string}
) {
  role(actor,"warehouse_admin","super_admin");
  const st=await one(db,"select * from stocktakes where id=$1 for update",[stocktakeId]);
  guard(st.state==="submitted","STOCKTAKE_UNAVAILABLE","Only submitted stocktakes with discrepancies require review.");
  const adjustments=(await db.query(
    `select ia.*,si.item_id,si.expected_location,si.actual_location
     from inventory_adjustments ia join stocktake_items si on si.id=ia.stocktake_item_id
     where si.stocktake_id=$1 for update of ia,si`,
    [stocktakeId]
  )).rows;
  guard(
    st.operator_id!==actor.id && adjustments.every(a=>a.requested_by!==actor.id),
    "SELF_REVIEW_FORBIDDEN",
    "Stocktake adjustments must be reviewed by a different staff member.",
    403
  );
  if(input.decision==="recount") {
    await db.query("update stocktake_items set state='recount_required' where stocktake_id=$1 and state='investigating'",[stocktakeId]);
    await db.query("update stocktakes set state='in_progress' where id=$1",[stocktakeId]);
    await audit(db,actor,"recount_stocktake","stocktakes",stocktakeId,{reason:input.reason.trim()});
    return {id:stocktakeId,state:"in_progress"};
  }
  for(const adj of adjustments) {
    await db.query("update inventory_adjustments set approved_by=$2 where id=$1",[adj.id,actor.id]);
    if(adj.actual_location) {
      await requireSpace(db,adj.actual_location,1);
      await db.query("update warehouse_items set location_id=$2,revision=revision+1 where id=$1",[adj.item_id,adj.actual_location]);
      await db.query(
        "insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,$3,'stocktake_adjustment',$4)",
        [adj.item_id,adj.expected_location,adj.actual_location,actor.id]
      );
    }
    await db.query("update stocktake_items set state='adjusted' where id=$1",[adj.stocktake_item_id]);
  }
  await db.query("update stocktakes set state='approved' where id=$1",[stocktakeId]);
  await audit(db,actor,"approve_stocktake","stocktakes",stocktakeId,{reason:input.reason.trim(),adjusted_count:adjustments.length});
  return {id:stocktakeId,state:"approved",adjusted_count:adjustments.length};
}

function canSeeIncidentFinance(actor:Actor) {
  return actor.roles.some(r=>["finance","super_admin"].includes(r));
}

export async function listIncidents(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","support","finance","super_admin");
  const {rows}=await db.query(
    `select ic.id,ic.item_id,w.code item_code,ic.ticket_id,t.public_no ticket_no,ic.order_line_id,
            l.order_id,o.public_no order_no,ic.evidence,ic.state,ic.resolution,ic.payment_proof
     from incident_cases ic
     join warehouse_items w on w.id=ic.item_id
     join tickets t on t.id=ic.ticket_id
     left join order_lines l on l.id=ic.order_line_id
     left join orders o on o.id=coalesce(l.order_id,t.order_id)
     order by t.created_at desc`
  );
  const financeVisible=canSeeIncidentFinance(actor);
  return {
    rows:rows.map(r=>{
      const res=(r.resolution??{}) as Record<string,unknown>;
      if(!financeVisible) {
        const {compensation_cents,service_refund_cents,currency,...publicRes}=res;
        return {
          ...r,
          resolution:{...publicRes,financial_restricted:true},
          payment_proof:r.payment_proof?{settled:true,financial_restricted:true}:null,
        };
      }
      return r;
    }),
  };
}

export async function createIncident(
  db:DB,
  actor:Actor,
  input:{
    item_id:string;
    order_id?:string;
    order_line_id?:string;
    kind:"damage"|"loss"|"wrong_inspection";
    summary_en:string;
    internal_note?:string;
    evidence_ids?:string[];
  }
) {
  role(actor,"receiver","warehouse_admin","support","super_admin");
  const item=await one(db,"select * from warehouse_items where id=$1 for update",[input.item_id]);
  guard(item.org_id,"ITEM_UNASSIGNED_ORG","Verify the item organization before creating a customer incident case.");
  await lock(db,"org:"+item.org_id);
  const link=(await db.query<{order_line_id:string;order_id:string}>(
    `select l.id order_line_id,l.order_id from order_line_item_links a join order_lines l on l.id=a.order_line_id
     where a.item_id=$1 and a.unlinked_at is null limit 1`,
    [item.id]
  )).rows[0];
  const orderLineId=input.order_line_id ?? link?.order_line_id ?? null;
  const orderId=input.order_id ?? link?.order_id ?? null;
  const ticketId=uuid(),incidentId=uuid();
  const ticketNo=code("INC-");
  await db.query(
    `insert into tickets(id,public_no,org_id,order_id,category,state,subject,details,next_action_at)
     values($1,$2,$3,$4,'damage_or_loss','open',$5,$6,now()+interval '24 hours')`,
    [ticketId,ticketNo,item.org_id,orderId,input.summary_en.trim(),{incident_id:incidentId,item_id:item.id,kind:input.kind,priority:"urgent"}]
  );
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body,media_ids)
     values($1,$2,'staff',$3,'message',$4,$5)`,
    [uuid(),ticketId,actor.id,input.summary_en.trim(),input.evidence_ids??[]]
  );
  if(input.internal_note?.trim()) {
    await db.query(
      `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
       values($1,$2,'staff',$3,'internal_note',$4)`,
      [uuid(),ticketId,actor.id,input.internal_note.trim()]
    );
  }
  const resolution={
    kind:input.kind,
    summary_en:input.summary_en.trim(),
    created_by:actor.id,
    created_at:new Date().toISOString(),
    compensation_state:"pending_proposal",
  };
  await db.query(
    `insert into incident_cases(id,item_id,ticket_id,order_line_id,evidence,state,resolution,payment_proof)
     values($1,$2,$3,$4,$5,'open',$6,null)`,
    [incidentId,item.id,ticketId,orderLineId,JSON.stringify({media_ids:input.evidence_ids??[]}),resolution]
  );
  if(orderId) {
    await db.query(
      `insert into order_blocks(id,order_id,reason,object_key,opened_at)
       values($1,$2,'incident_hold',$3,now())
       on conflict(order_id,reason,object_key) where resolved_at is null do nothing`,
      [uuid(),orderId,incidentId]
    );
  }
  await audit(db,actor,"create_incident","incident_cases",incidentId,{item_id:item.id,ticket_id:ticketId,kind:input.kind});
  return {id:incidentId,incident_id:incidentId,ticket_id:ticketId,ticket_no:ticketNo,state:"open"};
}

export async function proposeIncidentResolution(
  db:DB,
  actor:Actor,
  incidentId:string,
  input:{
    service_refund_cents?:number;
    compensation_cents?:number;
    currency?:string;
    summary_en:string;
    internal_note?:string;
  }
) {
  role(actor,"warehouse_admin","support","finance","super_admin");
  const ic=await one(db,"select * from incident_cases where id=$1 for update",[incidentId]);
  guard(["open","proposed","customer_rejected"].includes(ic.state),"INCIDENT_UNAVAILABLE","This incident cannot be re-proposed in its current state.");
  const serviceRefund=input.service_refund_cents??0;
  const compensation=input.compensation_cents??0;
  guard(serviceRefund>=0 && compensation>=0 && (serviceRefund>0 || compensation>0),"INVALID_AMOUNT","Specify a non-negative service refund or merchandise compensation amount.",422);

  // T103: Verify service_refund_cents does not exceed Stripe refundable balance on the order's inspection payment,
  // while merchandise compensation (compensation_cents) is independent and never touches Stripe refunds.
  const ticket=await one(db,"select * from tickets where id=$1",[ic.ticket_id]);
  if(serviceRefund>0 && ticket.order_id) {
    const paid=await one<{refundable:number}>(
      db,
      `select coalesce(sum(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id and r.state in ('approved','succeeded')),0)),0)::int refundable
       from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id join payments p on p.charge_item_id=c.id
       where q.order_id=$1 and p.state in ('succeeded','partially_refunded')`,
      [ticket.order_id]
    );
    guard(serviceRefund<=paid.refundable,"REFUND_EXCEEDS_PAYMENT","Service fee refund cannot exceed the original Stripe payment refundable balance.");
  }

  const nextRes={
    ...(ic.resolution??{}),
    proposed_by:actor.id,
    proposed_at:new Date().toISOString(),
    service_refund_cents:serviceRefund,
    compensation_cents:compensation,
    currency:(input.currency??"USD").toUpperCase(),
    proposal_summary_en:input.summary_en.trim(),
    compensation_state:compensation>0?"proposed":"none",
  };
  await db.query("update incident_cases set state='proposed',resolution=$2 where id=$1",[incidentId,nextRes]);
  if(input.internal_note?.trim()) {
    await db.query(
      "insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body) values($1,$2,'staff',$3,'internal_note',$4)",
      [uuid(),ic.ticket_id,actor.id,input.internal_note.trim()]
    );
  }
  await audit(db,actor,"propose_incident_resolution","incident_cases",incidentId,{
    service_refund_cents:serviceRefund,
    compensation_cents:compensation,
  });
  return {id:incidentId,state:"proposed",service_refund_cents:serviceRefund,compensation_cents:compensation};
}

export async function approveIncidentResolution(db:DB,actor:Actor,incidentId:string,input:{reason?:string}) {
  role(actor,"finance","super_admin");
  const ic=await one(db,"select * from incident_cases where id=$1 for update",[incidentId]);
  guard(ic.state==="proposed","INCIDENT_UNAVAILABLE","Only proposed incident resolutions can be approved.");
  const res=(ic.resolution??{}) as Record<string,unknown>;
  guard(res.proposed_by!==actor.id,"SELF_REVIEW_FORBIDDEN","Incident compensation proposals must be approved by a different reviewer.",403);
  const ticket=await one(db,"select * from tickets where id=$1 for update",[ic.ticket_id]);

  // If service_refund_cents > 0, create a standard Stripe refund request on the original inspection payment (not exceeding Stripe balance)
  let serviceRefundId:string|null=null;
  const serviceRefundCents=Number(res.service_refund_cents??0);
  if(serviceRefundCents>0 && ticket.order_id) {
    const payment=(await db.query<{id:string;refundable:number}>(
      `select p.id,(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id and r.state in ('approved','succeeded')),0))::int refundable
       from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id join payments p on p.charge_item_id=c.id
       where q.order_id=$1 and p.state in ('succeeded','partially_refunded') order by p.created_at desc limit 1 for update of p`,
      [ticket.order_id]
    )).rows[0];
    guard(payment && serviceRefundCents<=payment.refundable,"REFUND_EXCEEDS_PAYMENT","Service fee refund exceeds the remaining refundable Stripe balance.");
    serviceRefundId=uuid();
    await db.query(
      `insert into refunds(id,payment_id,source,amount_cents,reason,state,requested_by,revision)
       values($1,$2,'platform',$3,$4,'requested',$5,1)`,
      [serviceRefundId,payment.id,serviceRefundCents,`Incident ${incidentId} service fee refund`,res.proposed_by as string]
    );
  }

  const nextRes={
    ...res,
    approved_by:actor.id,
    approved_at:new Date().toISOString(),
    approval_reason:input.reason??null,
    service_refund_id:serviceRefundId,
    compensation_state:Number(res.compensation_cents??0)>0?"approved_unpaid":"none",
  };
  await db.query("update incident_cases set state='approved_awaiting_customer',resolution=$2 where id=$1",[incidentId,nextRes]);
  await db.query("update tickets set state='waiting_customer' where id=$1",[ic.ticket_id]);
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
     values($1,$2,'staff',$3,'message',$4)`,
    [uuid(),ic.ticket_id,actor.id,String(res.proposal_summary_en??res.summary_en??"Please review the proposed incident resolution.")]
  );
  await audit(db,actor,"approve_incident_resolution","incident_cases",incidentId,{
    service_refund_id:serviceRefundId,
    compensation_cents:res.compensation_cents??0,
  });
  return {
    id:incidentId,
    state:"approved_awaiting_customer",
    service_refund_id:serviceRefundId,
    compensation_state:nextRes.compensation_state,
  };
}

export async function customerReadIncident(db:DB,actor:Actor,incidentId:string) {
  const org=organization(actor);
  const row=await one(
    db,
    `select ic.id,ic.item_id,w.code item_code,ic.ticket_id,t.public_no ticket_no,t.order_id,
            ic.evidence,ic.state,ic.resolution,ic.payment_proof
     from incident_cases ic
     join warehouse_items w on w.id=ic.item_id
     join tickets t on t.id=ic.ticket_id
     where ic.id=$1 and w.org_id=$2`,
    [incidentId,org]
  );
  const res=(row.resolution??{}) as Record<string,unknown>;
  return {
    id:row.id,
    item_id:row.item_id,
    item_code:row.item_code,
    ticket_id:row.ticket_id,
    ticket_no:row.ticket_no,
    order_id:row.order_id,
    state:row.state,
    kind:res.kind??null,
    summary_en:res.summary_en??"",
    proposal_summary_en:res.proposal_summary_en??null,
    service_refund_cents:Number(res.service_refund_cents??0),
    compensation_cents:Number(res.compensation_cents??0),
    currency:res.currency??"USD",
    compensation_state:res.compensation_state??"pending_proposal",
    customer_decision:res.customer_decision??null,
    customer_accepted_at:res.customer_accepted_at??null,
    settled_at:res.settled_at??null,
    evidence_ids:(row.evidence?.media_ids??[]) as string[],
    paid:Boolean(row.payment_proof),
  };
}

export async function customerRespondIncident(
  db:DB,
  actor:Actor,
  incidentId:string,
  input:{decision:"accept"|"reject";note?:string}
) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  const row=await one(
    db,
    `select ic.* from incident_cases ic join warehouse_items w on w.id=ic.item_id
     where ic.id=$1 and w.org_id=$2 for update of ic`,
    [incidentId,org]
  );
  guard(row.state==="approved_awaiting_customer","INCIDENT_UNAVAILABLE","This incident case is not awaiting customer confirmation.");
  const res=(row.resolution??{}) as Record<string,unknown>;
  const compCents=Number(res.compensation_cents??0);
  // T103: Customer acceptance records agreement ONLY; if compensation > 0, it enters 'awaiting_payout' and is NEVER marked 'paid' until payment_proof is recorded!
  const nextState=input.decision==="reject"
    ?"customer_rejected"
    :(compCents>0?"awaiting_payout":"resolved");
  const nextCompState=input.decision==="reject"
    ?"customer_rejected"
    :(compCents>0?"accepted_unpaid":"none");
  const nextRes={
    ...res,
    customer_decision:input.decision,
    customer_accepted_at:input.decision==="accept"?new Date().toISOString():null,
    customer_note:input.note?.trim()??null,
    compensation_state:nextCompState,
  };
  await db.query("update incident_cases set state=$2,resolution=$3 where id=$1",[incidentId,nextState,nextRes]);
  await db.query(
    `insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body)
     values($1,$2,'customer',$3,'message',$4)`,
    [uuid(),row.ticket_id,actor.id,input.note?.trim()||`Customer ${input.decision}ed the incident resolution.`]
  );
  await db.query(
    "update tickets set state=$2 where id=$1",
    [row.ticket_id,nextState==="resolved"?"resolved":"waiting_internal"]
  );
  await audit(db,actor,"customer_respond_incident","incident_cases",incidentId,{decision:input.decision,state:nextState});
  return {
    id:incidentId,
    state:nextState,
    compensation_state:nextCompState,
    paid:false,
  };
}

export async function resolveIncidentCompensation(
  db:DB,
  actor:Actor,
  incidentId:string,
  input:{
    payout_reference:string;
    payout_method:string;
    paid_amount_cents:number;
    currency?:string;
    proof_media_ids?:string[];
    note?:string;
  }
) {
  role(actor,"finance","super_admin");
  const ic=await one(db,"select * from incident_cases where id=$1 for update",[incidentId]);
  const res=(ic.resolution??{}) as Record<string,unknown>;
  guard(ic.state==="awaiting_payout" && res.customer_decision==="accept","INCIDENT_UNAVAILABLE","Customer acceptance is required before recording compensation payout.");
  const expectedCents=Number(res.compensation_cents??0);
  guard(input.payout_reference.trim().length>=2,"COMPENSATION_PROOF_REQUIRED","Provide the external payout reference or voucher number.",422);
  guard(input.paid_amount_cents===expectedCents,"COMPENSATION_AMOUNT_MISMATCH","Paid compensation amount must match the approved merchandise compensation.");

  const proof={
    payout_reference:input.payout_reference.trim(),
    payout_method:input.payout_method.trim(),
    paid_amount_cents:input.paid_amount_cents,
    currency:(input.currency??String(res.currency??"USD")).toUpperCase(),
    proof_media_ids:input.proof_media_ids??[],
    note:input.note?.trim()??null,
    recorded_by:actor.id,
    paid_at:new Date().toISOString(),
  };
  const nextRes={
    ...res,
    compensation_state:"paid",
    settled_at:proof.paid_at,
  };
  await db.query(
    "update incident_cases set state='resolved',payment_proof=$2,resolution=$3 where id=$1",
    [incidentId,proof,nextRes]
  );
  const ticket=await one(db,"select * from tickets where id=$1 for update",[ic.ticket_id]);
  await db.query("update tickets set state='resolved',resolved_at=now(),next_action_at=null where id=$1",[ic.ticket_id]);
  if(ticket.order_id) {
    await db.query(
      "update order_blocks set resolved_at=now() where order_id=$1 and reason='incident_hold' and object_key=$2 and resolved_at is null",
      [ticket.order_id,incidentId]
    );
  }
  await audit(db,actor,"resolve_incident_compensation","incident_cases",incidentId,{
    payout_reference:proof.payout_reference,
    paid_amount_cents:proof.paid_amount_cents,
  });
  await event(db,"incident.resolved",{incident_id:incidentId,ticket_id:ic.ticket_id});
  return {
    id:incidentId,
    state:"resolved",
    compensation_state:"paid",
    paid:true,
    payment_proof:proof,
  };
}

export async function listOverdueAndRestrictedQueue(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","support","super_admin");
  const candidateItems=(await db.query(
    `select w.id,w.code,w.org_id,w.package_id,p.code package_code,
            w.identity_state,w.condition_state,w.custody_state,w.received_at,w.storage_until,
            (w.storage_until is not null and w.storage_until<=now()) overdue,
            (w.identity_state='quarantined') quarantined,
            loc.code location_code
     from warehouse_items w
     join packages p on p.id=w.package_id
     left join storage_locations loc on loc.id=w.location_id
     where w.custody_state in ('received','stored')
       and (w.identity_state='quarantined' or (w.storage_until is not null and w.storage_until<=now()))
     order by w.identity_state='quarantined' desc,w.storage_until asc nulls last,w.received_at asc
     limit 100`
  )).rows;
  const cases=(await db.query(
    `select dc.id,dc.org_id,dc.state,dc.revision,dc.policy_snapshot,dc.authorization_snapshot,
            dc.requested_by,dc.approved_by,dc.execution_evidence,
            coalesce(array(
              select w.code from disposal_items di join warehouse_items w on w.id=di.item_id
              where di.case_id=dc.id order by w.code
            ), array[]::text[]) item_codes,
            coalesce(array(
              select di.item_id from disposal_items di where di.case_id=dc.id order by di.item_id
            ), array[]::uuid[]) item_ids
     from disposal_cases dc
     order by dc.state='pending_approval' desc,dc.state='approved' desc,dc.id desc
     limit 100`
  )).rows;
  const execFlag=(await db.query<{value:unknown}>("select value from app_config where key='disposal.production_execution_enabled'")).rows[0];
  const prodEnabled=execFlag?.value===true || (typeof execFlag?.value==="object" && execFlag?.value!==null && (execFlag.value as {enabled?:boolean}).enabled===true);
  return {
    production_execution_enabled:prodEnabled,
    production_execution_switch:{enabled:prodEnabled},
    candidate_items:candidateItems,
    overdue_items:candidateItems.filter(i=>i.overdue),
    restricted_items:candidateItems.filter(i=>i.quarantined),
    cases,
  };
}

export async function createDisposalCase(
  db:DB,
  actor:Actor,
  input:{
    org_id?:string;
    item_ids:string[];
    reason:string;
    legal_basis?:string;
    legal_basis_version?:string;
    customer_authorized?:boolean;
    notice_evidence_ids?:string[];
  }
) {
  role(actor,"receiver","warehouse_admin","support","super_admin");
  const itemIds=[...new Set(input.item_ids)].sort();
  guard(itemIds.length>=1,"INVALID_REQUEST","Select at least one item for the disposal case.",422);
  const items=(await db.query<{
    id:string;
    code:string;
    org_id:string|null;
    custody_state:string;
    identity_state:string;
    storage_until:Date|null;
  }>("select id,code,org_id,custody_state,identity_state,storage_until from warehouse_items where id=any($1::uuid[]) order by id for update",[itemIds])).rows;
  guard(items.length===itemIds.length,"ITEM_NOT_FOUND","One or more selected items were not found.",404);
  const orgSet=new Set(items.map(i=>i.org_id??""));
  guard(orgSet.size===1,"TENANT_MISMATCH","All items in a disposal case must belong to the same organization.");
  for(const item of items) {
    guard(["received","stored"].includes(item.custody_state),"ITEM_UNAVAILABLE",`Item ${item.code} is not in warehouse storage.`);
    const isEligible=item.identity_state==="quarantined" || (item.storage_until && new Date(item.storage_until)<=new Date());
    guard(isEligible,"DISPOSAL_NOT_ELIGIBLE",`Item ${item.code} is neither quarantined nor past its storage retention deadline.`);
  }
  const orgId=items[0].org_id;
  const listHash=hash(itemIds.join(","));
  const caseId=uuid();
  const ticketId=uuid(),ticketNo=code("DSP-");
  const legalBasis=(input.legal_basis??input.legal_basis_version)?.trim()||"TOS-2026-V2";
  await db.query(
    `insert into tickets(id,public_no,org_id,category,state,subject,details,next_action_at)
     values($1,$2,$3,'disposal','open',$4,$5,now()+interval '24 hours')`,
    [
      ticketId,
      ticketNo,
      orgId,
      `Overdue / restricted item disposal case (${items.map(i=>i.code).join(", ")})`,
      {disposal_case_id:caseId,item_codes:items.map(i=>i.code),reason:input.reason.trim(),list_hash:listHash},
    ]
  );
  const policySnapshot={
    reason:input.reason.trim(),
    legal_basis:legalBasis,
    legal_basis_version:legalBasis,
    list_hash:listHash,
    ticket_id:ticketId,
    ticket_no:ticketNo,
    item_codes:items.map(i=>i.code),
    created_at:new Date().toISOString(),
  };
  const authSnapshot={
    list_hash:listHash,
    customer_authorized:Boolean(input.customer_authorized),
    notice_evidence_ids:input.notice_evidence_ids??[],
  };
  await db.query(
    `insert into disposal_cases(id,org_id,state,revision,policy_snapshot,authorization_snapshot,requested_by)
     values($1,$2,'pending_approval',1,$3,$4,$5)`,
    [caseId,orgId,policySnapshot,authSnapshot,actor.id]
  );
  for(const id of itemIds) {
    await db.query("insert into disposal_items(case_id,item_id) values($1,$2)",[caseId,id]);
  }
  await audit(db,actor,"create_disposal_case","disposal_cases",caseId,{
    count:itemIds.length,
    reason:input.reason.trim(),
  });
  return {
    id:caseId,
    case_id:caseId,
    ticket_id:ticketId,
    ticket_no:ticketNo,
    state:"pending_approval",
    revision:1,
    list_hash:listHash,
  };
}

export async function approveDisposalCase(
  db:DB,
  actor:Actor,
  caseId:string,
  input:{
    revision:number;
    list_hash?:string;
    legal_basis?:string;
    customer_authorized?:boolean;
    evidence_note?:string;
    reason?:string;
    evidence_ids?:string[];
  }
) {
  role(actor,"reviewer","warehouse_admin","super_admin");
  const dc=await one<{
    id:string;
    state:string;
    revision:number;
    requested_by:string;
    policy_snapshot:Record<string,unknown>;
    authorization_snapshot:Record<string,unknown>|null;
  }>(db,"select * from disposal_cases where id=$1 for update",[caseId]);
  revision(dc.revision,input.revision);
  guard(dc.state==="pending_approval","DISPOSAL_UNAVAILABLE","This disposal case is not awaiting approval.");
  guard(dc.requested_by!==actor.id,"SELF_REVIEW_FORBIDDEN","Disposal cases require independent dual-control approval by another administrator.",403);
  const currentItemIds=(await db.query<{item_id:string}>("select item_id from disposal_items where case_id=$1 order by item_id",[caseId])).rows.map(r=>r.item_id);
  const currentHash=hash(currentItemIds.join(","));
  guard(
    currentHash===dc.policy_snapshot?.list_hash && (!input.list_hash || input.list_hash===currentHash),
    "DISPOSAL_LIST_CHANGED",
    "The disposal item list changed since the case was submitted; re-verify the item list hash."
  );
  const legalBasis=(input.legal_basis??String(dc.policy_snapshot?.legal_basis??"TOS-2026-V2")).trim();
  const note=(input.evidence_note??input.reason??"Independent dual-control approval").trim();
  const nextPolicy={
    ...dc.policy_snapshot,
    legal_basis:legalBasis,
    approved_list_hash:currentHash,
  };
  const nextAuth={
    ...(dc.authorization_snapshot??{}),
    list_hash:currentHash,
    customer_authorized:input.customer_authorized ?? Boolean(dc.authorization_snapshot?.customer_authorized),
    approval_evidence_note:note,
    approval_evidence_ids:input.evidence_ids??[],
    approved_at:new Date().toISOString(),
  };
  const nextRev=dc.revision+1;
  await db.query(
    `insert into disposal_case_approvals(case_id,revision,list_hash,evidence,actor_id,approved_at)
     values($1,$2,$3,$4,$5,now())`,
    [caseId,nextRev,currentHash,{legal_basis:legalBasis,note,evidence_ids:input.evidence_ids??[]},actor.id]
  );
  await db.query(
    `update disposal_cases set state='approved',approved_by=$2,policy_snapshot=$3,authorization_snapshot=$4,revision=$5
     where id=$1`,
    [caseId,actor.id,nextPolicy,nextAuth,nextRev]
  );
  await audit(db,actor,"approve_disposal_case","disposal_cases",caseId,{
    revision:nextRev,
    reason:note,
  });
  return {
    id:caseId,
    state:"approved",
    revision:nextRev,
    list_hash:currentHash,
    approved_by:actor.id,
  };
}

export async function executeDisposalCase(
  db:DB,
  actor:Actor,
  caseId:string,
  input:{
    revision:number;
    media_ids?:string[];
    execution_note?:string;
    method?:string;
    witness_note?:string;
  }
) {
  role(actor,"warehouse_admin","super_admin");
  const dc=await one<{
    id:string;
    state:string;
    revision:number;
    requested_by:string;
    approved_by:string|null;
    policy_snapshot:Record<string,unknown>;
    authorization_snapshot:Record<string,unknown>|null;
  }>(db,"select * from disposal_cases where id=$1 for update",[caseId]);
  revision(dc.revision,input.revision);
  guard(dc.state==="approved" && dc.approved_by && dc.approved_by!==dc.requested_by,
    "DISPOSAL_NOT_APPROVED","Disposal execution requires dual-control approval first.");

  // T104: Physical disposal execution is disabled in production unless formal legal basis / customer authorization AND production switch are present
  const legalBasis=String(dc.policy_snapshot?.legal_basis??"").trim();
  const hasFormalBasis=legalBasis.length>=3 && legalBasis.toLowerCase()!=="none" && legalBasis.toLowerCase()!=="missing";
  const execSwitch=(await db.query<{value:unknown}>("select value from app_config where key='disposal.production_execution_enabled'")).rows[0];
  const switchEnabled=execSwitch?.value===true || (typeof execSwitch?.value==="object" && execSwitch?.value!==null && (execSwitch.value as {enabled?:boolean}).enabled===true);
  guard(hasFormalBasis && switchEnabled,
    "DISPOSAL_EXECUTION_DISABLED",
    "Physical disposal execution is disabled until formal legal basis, customer notice/authorization, and the disposal execution switch are enabled.",
    409);

  const itemIds=(await db.query<{item_id:string}>("select item_id from disposal_items where case_id=$1 order by item_id",[caseId])).rows.map(r=>r.item_id);
  const currentHash=hash(itemIds.join(","));
  guard(currentHash===dc.policy_snapshot?.list_hash,"DISPOSAL_LIST_CHANGED","Disposal item list hash mismatch.");

  for(const itemId of itemIds) {
    const item=await one<{id:string;location_id:string|null;custody_state:string}>(
      db,"select id,location_id,custody_state from warehouse_items where id=$1 for update",[itemId]
    );
    guard(["received","stored"].includes(item.custody_state),"ITEM_UNAVAILABLE","Item is no longer in warehouse custody.");
    await db.query(
      "update warehouse_items set custody_state='disposed',location_id=null,revision=revision+1 where id=$1",
      [itemId]
    );
    await db.query(
      "insert into storage_events(item_id,from_location_id,to_location_id,action,operator_id) values($1,$2,null,'dispose',$3)",
      [itemId,item.location_id,actor.id]
    );
  }
  const execNote=(input.execution_note??input.witness_note??"Dual-person physical disposal completed").trim();
  const execEvidence={
    executed_by:actor.id,
    executed_at:new Date().toISOString(),
    method:input.method??"destroy",
    media_ids:input.media_ids??[],
    execution_note:execNote,
    list_hash:currentHash,
  };
  const nextRev=dc.revision+1;
  await db.query(
    "update disposal_cases set state='executed',execution_evidence=$2,revision=$3 where id=$1",
    [caseId,execEvidence,nextRev]
  );
  if(dc.policy_snapshot?.ticket_id) {
    await db.query(
      "update tickets set state='resolved',resolved_at=now(),next_action_at=null where id=$1",
      [dc.policy_snapshot.ticket_id]
    );
  }
  await audit(db,actor,"execute_disposal_case","disposal_cases",caseId,{
    count:itemIds.length,
    revision:nextRev,
  });
  return {
    id:caseId,
    state:"executed",
    revision:nextRev,
    disposed_item_ids:itemIds,
  };
}


