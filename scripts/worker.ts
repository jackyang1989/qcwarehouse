import { setTimeout as sleep } from "node:timers/promises";
import { workOnce, trackingTick } from "../packages/core/worker";
import { pool } from "../packages/db";

async function main() {
  let running=true,last=0;
  process.on("SIGINT",()=>{running=false});
  process.on("SIGTERM",()=>{running=false});
  while(running) {
    try {
      const worked=await workOnce();
      if(Date.now()-last>60000) {last=Date.now(); await trackingTick();}
      if(!worked) await sleep(1500);
    } catch {
      console.error("Worker job failed. Check the retry record.");
      await sleep(2000);
    }
  }
  await pool.end();
}
void main();
