import { addEmailOtpIdentity } from "../packages/core/auth";
import { APPAREL_SUBCATEGORY_TEMPLATES } from "../packages/core/inspection";
import { pool, transaction } from "../packages/db";
import { hash, lock, one, uuid } from "../packages/core/common";

async function seed() {
  if(process.env.QCW_DEMO!=="1" || process.env.NODE_ENV==="production") throw new Error("Demo data requires local QCW_DEMO=1.");
  await transaction(async db=>{
    await lock(db,"seed_demo");
    const done=(await db.query("select 1 from app_config where key='demo.seeded'")).rowCount;
    if(done) return;
    const actors=new Map<string,string>();
    for(const [label,roles] of [
      ["receiving",["receiver","warehouse_admin"]],["inspector",["inspector","template_admin"]],
      ["reviewer",["reviewer"]],["admin",["super_admin","finance","support"]]
    ] as const) {
      const email=label+"@qcw.test",id=uuid();actors.set(label,id);
      await db.query("insert into users(id,display_name,locale) values($1,$2,'zh-CN')",[id,label]);
      const verified=await one<{id:string}>(db,`insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
        values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,[id,email]);
      await addEmailOtpIdentity(db,id,verified.id);
      for(const role of roles) await db.query("insert into staff_roles(user_id,role) values($1,$2)",[id,role]);
    }
    const admin=actors.get("admin")!, reviewer=actors.get("reviewer")!, inspector=actors.get("inspector")!;
    const addrId=uuid();
    await db.query(`insert into warehouse_addresses(id,address_zh,address_en,contact_name,contact_phone,is_default)
      values($1,'广东省佛山市南海区桂城街道质检演示仓 3 号库','Unit 3, QC Inspection Center, Nanhai District, Foshan, Guangdong, China','QCW 收货组','13800138000',true)`,[addrId]);
    await db.query(`insert into storage_locations(id,code,zone,capacity,notes) values
      ($1,'R-01','receiving',null,'到件暂存区'),
      ($2,'S-01','post_inspection',null,'检后存放区'),
      ($3,'Q-01','quarantine',null,'异常与隔离区'),
      ($4,'A-04-02-01','post_inspection',10,'A区 04架 02层 01格'),
      ($5,'A-04-02-02','post_inspection',10,'A区 04架 02层 02格'),
      ($6,'A-04-02-03','reference',10,'确认样专区'),
      ($7,'U-01','unmatched',20,'未关联/待认领包裹与实物暂存区'),
      ($8,'W-01','queue',30,'待检排队货架区'),
      ($9,'I-01','inspecting',15,'质检台作业暂存区')`,[uuid(),uuid(),uuid(),uuid(),uuid(),uuid(),uuid(),uuid(),uuid()]);
    const custId=uuid(), custOrgId=uuid();
    await db.query("insert into users(id,display_name,locale) values($1,'Demo Customer','en')",[custId]);
    await db.query("insert into organizations(id,name) values($1,'Personal workspace')",[custOrgId]);
    await db.query("insert into memberships(user_id,org_id) values($1,$2)",[custId,custOrgId]);
    await db.query("insert into customer_receiving_profiles(user_id,org_id,receiving_code) values($1,$2,'QCW-8F2K5')",[custId,custOrgId]);
    const custEmail=await one<{id:string}>(db,`insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
      values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,[custId,"customer@qcw.test"]);
    await addEmailOtpIdentity(db,custId,custEmail.id);
    for(const kind of ["terms","privacy","restricted_items","report_notice"]) {
      const content="Development fixture. Use test parcels and simulated payments only. No physical shipment is requested.";
      await db.query("insert into terms_versions(id,kind,version,effective_at,content_md,content_hash) values($1,$2,'demo-v1',now(),$3,$4)",[uuid(),kind,content,hash(content)]);
    }
    for(const [c,provider,en,zh,required] of [
      ["sf","shunfeng","SF Express","顺丰",true],["zto","zhongtong","ZTO Express","中通",false],["yto","yuantong","YTO Express","圆通",false],
      ["sto","shentong","STO Express","申通",false],["yd","yunda","Yunda Express","韵达",false],["jt","jtexpress","J&T Express","极兔",false],
      ["jd","jd","JD Logistics","京东",false],["ems","ems","EMS","EMS",false]
    ] as const) await db.query("insert into carriers(code,provider_code,labels,phone_rule,enabled) values($1,$2,$3,$4,true)",[c,provider,{en,"zh-CN":zh},{required}]);
    const capability=await one<{id:string}>(db,"insert into capabilities(code,method,approval,approved_by) values('demo-visual','visual and ruler',$1,$2) returning id",[{demo:true},reviewer]);
    for(const [slug,en,zh] of [["apparel","Apparel","服装"],["bags","Bags","箱包"],["home","Home goods","家居用品"]]) {
      await db.query("insert into categories(slug,labels,status,admission_snapshot) values($1,$2,$3,$4)",[slug,{en,"zh-CN":zh},slug==="apparel"?"ACTIVE":"PLANNED",slug==="apparel"?{demo:true}:null]);
    }
    const category=await one<{id:string}>(db,"select id from categories where slug='apparel'");
    const checks=[
      {key:"appearance",label:"Visible condition",zh:"外观",type:"boolean",method:"Visual observation",required:true,evidence:true,parts:["collar","chest_front","waistband","crotch_gusset","hem"]},
      {key:"width",label:"Flat width",zh:"平铺宽度",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/tops.svg",method:"Measure laid flat without stretching",required:true,evidence:true},
      {key:"label",label:"Label transcription",zh:"标签记录",type:"text",method:"Read the visible label",required:false,evidence:false},
      {key:"body_length_cm",label:"Front Body Length HPS",zh:"前衣长 (上衣)",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/tops.svg",method:"Measure from High Point Shoulder (HPS) vertically down to bottom hem.",required:true,evidence:false,applies_if:{garment_type:"tops"}},
      {key:"shoulder_width_cm",label:"Shoulder Width",zh:"肩宽 (上衣)",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/tops.svg",method:"Measure straight from left shoulder point to right shoulder point.",required:true,evidence:false,applies_if:{garment_type:"tops"}},
      {key:"sleeve_length_cm",label:"Sleeve Length",zh:"袖长 (上衣)",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/tops.svg",method:"Measure from shoulder seam apex to cuff edge.",required:true,evidence:false,applies_if:{garment_type:"tops"}},
      {key:"waist_flat_cm",label:"1/2 Waist Width Relaxed",zh:"平铺半腰围 (裤装)",type:"number",unit:"cm",precision:0.1,derived:{circumference_cm:"2x"},diagram:"/diagrams/bottoms.svg",method:"Align front and back top edges of waistband; measure straight across.",required:true,evidence:false,applies_if:{garment_type:"bottoms"}},
      {key:"hip_flat_cm",label:"1/2 Hip Width Flat",zh:"平铺半臀围 (裤装)",type:"number",unit:"cm",precision:0.1,derived:{circumference_cm:"2x"},diagram:"/diagrams/bottoms.svg",method:"Measure straight across hip.",required:true,evidence:false,applies_if:{garment_type:"bottoms"}},
      {key:"inseam_cm",label:"Inseam Length",zh:"内长/裤内长 (裤装)",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/bottoms.svg",method:"Measure from crotch seam intersection along inner leg seam to bottom ankle opening.",required:true,evidence:false,applies_if:{garment_type:"bottoms"}},
      {key:"underbust_flat_cm",label:"1/2 Underbust Band Relaxed",zh:"平铺半下扒宽 (运动内衣)",type:"number",unit:"cm",precision:0.1,derived:{circumference_cm:"2x"},diagram:"/diagrams/sports_bra.svg",method:"Measure straight across bottom edge of elastic underbust band relaxed.",required:true,evidence:false,applies_if:{garment_type:"sports_bra"}},
      {key:"strap_to_hem_cm",label:"Total Length HPS to Underbust",zh:"肩带顶点至下扒总长 (运动内衣)",type:"number",unit:"cm",precision:0.1,diagram:"/diagrams/sports_bra.svg",method:"Measure vertically from top of shoulder strap to bottom edge of underbust band.",required:true,evidence:false,applies_if:{garment_type:"sports_bra"}},
    ];
    const serviceTypeIds=new Map<string,string>();
    for(const [service,en,zh,offers] of [
      ["inspection","Item inspection","逐件检查",[[1,100,2900]]],
      ["compare","Side-by-side comparison","横向对比",[[2,2,5900],[3,3,7900]]],
      ["reference_match","Reference comparison","确认样对照",[[1,1,3900]]]
    ] as const) {
      const type=await one<{id:string}>(db,"insert into service_types(code,labels) values($1,$2) returning id",[service,{en,"zh-CN":zh}]);
      serviceTypeIds.set(service,type.id);
      const baseContent={
        checks,
        diagram:"/diagrams/tops.svg",
        measure_conditions:"Garment laid flat on standard inspection table without stretching; steel tape calibrated to 0.1 cm.",
        parts:[
          {code:"collar",label:"Collar / Neckband (领口)"},
          {code:"chest_front",label:"Front Chest Panel (前胸)"},
          {code:"waistband",label:"Waistband (腰头)"},
          {code:"crotch_gusset",label:"Crotch / Gusset (裆部)"},
          {code:"side_seam",label:"Side Seam (侧缝)"},
          {code:"hem",label:"Bottom Hem / Cuff (下摆/脚口)"},
          {code:"care_label",label:"Main / Care Label (主唛/洗水唛)"},
        ],
      };
      const tpl=await one<{id:string}>(db,`insert into template_versions(template_key,category_id,service_type_id,version,content,content_hash,state,author_id,reviewer_id,published_at)
        values($1,$2,$3,1,$4,$5,'PUBLISHED',$6,$7,now()) returning id`,["apparel-"+service,category.id,type.id,baseContent,hash(JSON.stringify(baseContent)),inspector,reviewer]);
      await db.query("insert into template_capabilities values($1,$2)",[tpl.id,capability.id]);
      for(const [minimum,maximum,price] of offers) {
        const offer=await one<{id:string}>(db,"insert into service_offers(sku_code,service_type_id,title,enabled) values($1,$2,$3,true) returning id",
          ["apparel-"+service+"-"+minimum,type.id,{en:service==="compare"?en+" · "+minimum+" items":en,"zh-CN":zh}]);
        await db.query("insert into offer_templates values($1,$2,$3,$4)",[offer.id,category.id,type.id,tpl.id]);
        await db.query("insert into sku_prices(offer_id,version,currency,rules,effective_from) values($1,1,'USD',$2,now())",
          [offer.id,{minimum,maximum,...(service==="inspection"?{unit_cents:price}:{package_cents:price}),business_days:3,demo:true}]);
      }
    }
    // Delegate apparel subcategory templates & offers to the migration-governed database function
    await db.query("select ensure_apparel_subcategory_catalog()");
    await db.query("insert into shipping_rate_versions values($1,1,$2,now(),$3)",[uuid(),{first_weight_g:1000,first_cents:850,extra_step_g:500,extra_cents:200,handling_cents:300},admin]);
    await db.query("insert into app_config(key,value) values('storage.daily_cents','25'),('demo.seeded','true')");
  });
  console.log("Demo fixtures ready.");
}
seed().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
