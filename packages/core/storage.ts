import { z } from "zod";
import type { DB } from "../db";
import { audit, guard, one, role, uuid, type Actor } from "./common";
import { staffAccess } from "./staff-access";

const occupied = "w.custody_state in ('received','stored')";
export const storageZones = z.enum(["receiving","queue","inspecting","post_inspection","reference","unmatched","quarantine"]);
const slot = z.number().int().min(1).max(99);
export const locationBatchSchema = z.object({
  prefix:z.string().regex(/^[A-Z]$/),zone:storageZones,rack:slot,level:slot,start:slot,end:slot,
  capacity:z.number().int().min(1).max(999),notes:z.string().trim().max(200).optional(),
}).refine(input=>input.start<=input.end,"The slot range must be in ascending order.");

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
