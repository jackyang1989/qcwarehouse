"use client";

import Link from "next/link";
import { useState } from "react";
import { Empty, ErrorBlock, Form, Panel, request, RequestError, stamp, Table, Tag, text, useLoad, type Row } from "./ui";

const jobNames:Record<string,string>={
  "report.render":"生成报告 PDF","refund.approved":"执行已审批退款",
  "report.published":"报告发布通知","report.amended":"报告修订通知","ticket.reply":"客服回复通知",
  "account.registered":"注册后续处理","package.received":"实收入仓通知","order.ready":"开检准备通知",
  "order.cancelled":"取消检查通知","dispatch.quoted":"发运报价通知","quote.offered":"人工报价通知",
  "shipment.handed_over":"交接后通知","shipment.return_received":"退回实收通知","payment.confirmed":"付款确认通知",
};
export function OperationsDesk() {
  const {data,error,reload}=useLoad("/staff/admin/jobs");
  const [emailState,setEmailState]=useState("");
  const email=useLoad("/staff/admin/email-deliveries"+(emailState?"?state="+encodeURIComponent(emailState):""));
  const [reauth,setReauth]=useState(false);
  const [scheduled,setScheduled]=useState<string>();
  const [retriedEmail,setRetriedEmail]=useState<string>();
  return <>
    <div className="page-head"><p className="eyebrow">OPERATIONS / BACKGROUND JOBS</p><h1>后台作业与邮件通道恢复</h1>
      <p className="muted">核对失败原因、邮件通道告警与退信抑制状态，完成修复后重新安排作业或受控补发通知。</p></div>
    {error&&<ErrorBlock error={error}/>}
    {email.error&&<ErrorBlock error={email.error}/>}
    {email.data?.channel_alert?.message&&<div className="notice" role="alert"><strong>邮件通道独立告警：</strong>{email.data.channel_alert.message}</div>}
    {!data&&!error&&<p role="status">正在读取失败队列…</p>}
    {data&&!error&&<Panel title="失败待处理">
      {!data.rows.length&&<Empty>当前没有可重排的失败作业。</Empty>}
      {data.rows.map((job:Row)=><details className="card" key={job.id+"-"+job.attempts}>
        <summary><span className="code">#{job.id}</span> · {jobNames[job.type]??job.type} · <Tag>
          {job.attempts>=data.max_attempts?"自动重试已耗尽":"等待自动重试"}
        </Tag></summary>
        <Table headers={["已尝试","最近错误码","下一自动重试","关联订单"]} rows={[[
          job.attempts,job.last_error??"—",job.attempts>=data.max_attempts?"等待人工恢复":stamp(job.next_attempt_at),
          job.order_number?<Link href={"/admin/orders/"+job.order_number}>{job.order_number}</Link>:"—",
        ]]}/>
        <Form label="重新安排原作业" run={async fields=>{
          if(!window.confirm("确认已核对失败原因，并重新安排这个原作业？"))return;
          try {
            await request("/staff/admin/jobs/"+job.id+"/retry","POST",{attempts:job.attempts,reason:text(fields,"reason")});
            setScheduled(job.id);reload();
          } catch(e) {
            if(e instanceof RequestError&&e.code==="STAFF_REAUTH_REQUIRED")setReauth(true);
            throw e;
          }
        }}><label>修复内容与重排依据<textarea name="reason" required minLength={4} maxLength={1000}/></label></Form>
      </details>)}
      <button type="button" onClick={reload}>刷新作业状态</button>
    </Panel>}
    <Panel title="邮件投递与退信抑制">
      <div className="form inline-form">
        <label>投递状态<select value={emailState} onChange={e=>setEmailState(e.target.value)}>
          <option value="">全部状态</option>
          <option value="unknown">超时未知 (unknown)</option>
          <option value="deferred">延后待重试 (deferred)</option>
          <option value="bounced">硬退信 (bounced)</option>
          <option value="complained">垃圾投诉 (complained)</option>
          <option value="submitted">已提交供应商 (submitted)</option>
          <option value="delivered">已送达 (delivered)</option>
          <option value="queued">排队中 (queued)</option>
        </select></label>
        <button type="button" onClick={email.reload}>刷新邮件状态</button>
      </div>
      {email.data&&!email.data.rows.length&&<Empty>当前筛选条件下没有邮件投递记录。</Empty>}
      {email.data?.rows.map((row:Row)=><details className="card" key={row.id}>
        <summary><span className="code">{row.masked_email}</span> · {jobNames[row.template]??row.template} · 尝试 #{row.attempt} · <Tag>{row.state}</Tag>{row.suppressed&&<> · <Tag>地址已抑制 ({row.delivery_state})</Tag></>}</summary>
        <Table headers={["关联订单","供应商 MessageID","地址状态","错误码","更新时间"]} rows={[[
          row.order_public_no?<Link href={"/admin/orders/"+row.order_public_no}>{row.order_public_no}</Link>:"—",
          row.provider_message_id??"—",
          row.delivery_state,
          row.error_code??"—",
          stamp(row.updated_at),
        ]]}/>
        {row.can_retry&&<Form label="新建下一投递尝试 (attempt + 1)" run={async fields=>{
          try {
            await request("/staff/admin/email-deliveries/"+row.id+"/retry","POST",{attempt:row.attempt,reason:text(fields,"reason")});
            setRetriedEmail(row.id);email.reload();
          } catch(e) {
            if(e instanceof RequestError&&e.code==="STAFF_REAUTH_REQUIRED")setReauth(true);
            throw e;
          }
        }}><label>核查结论与重发原因<textarea name="reason" required minLength={4} maxLength={1000}/></label></Form>}
      </details>)}
    </Panel>
    {scheduled&&<p className="notice" role="status">作业 #{scheduled} 已重新排队，处理结果请刷新核对。</p>}
    {retriedEmail&&<p className="notice" role="status">邮件记录 {retriedEmail} 已创建新投递尝试并加入队列。</p>}
    {reauth&&<p className="notice"><Link href="/staff/login?next=%2Fadmin%2Foperations">重新验证员工身份后继续</Link></p>}
    <SystemHealthAndRecoveryPanel/>
    <LaunchReadinessAndRehearsalPanel/>
  </>;
}

function SystemHealthAndRecoveryPanel() {
  const health=useLoad("/staff/admin/system-health");
  const h=health.data;
  const counts=h?.counts??{};
  const runs=h?.recovery_runs??h?.recent_recovery_runs??[];
  return <Panel title="系统健康、备份校验与恢复演练">
    <p className="muted">验证对象存储/私有媒体完整性，登记备份恢复演练并重放恢复时间点后的会话撤销、账号注销、解绑与退信抑制清单（T105），同时核对外部支付与出库交接一致性（T106）。</p>
    {health.error&&<ErrorBlock error={health.error}/>}
    {h&&<>
      <div className="metric-strip" aria-label="系统健康与备份">
        <div className="metric"><span>系统健康状态</span><strong>{h.healthy?"正常":"告警"}</strong><small>不可变触发器 {(h.immutable_triggers??[]).length} 个</small></div>
        <div className="metric"><span>订单 / 已发布报告</span><strong>{counts.orders_count??0} / {counts.reports_count??0}</strong><small>收款记录 {counts.payments_count??0}</small></div>
        <div className="metric"><span>待执行 / 失败作业</span><strong>{counts.pending_jobs_count??0} / {counts.failed_jobs_count??0}</strong><small>审计事件 {counts.audit_count??0}</small></div>
        <div className="metric"><span>恢复演练记录</span><strong>{runs.length}</strong><small>RPO / RTO 审计</small></div>
      </div>
      <div className="ops-columns">
        <div>
          <Form label="登记恢复演练与安全撤销清单重放（T105 / T106）" run={async f=>{
            const sess=text(f,"revoked_session_ids").split(",").map(s=>s.trim()).filter(Boolean);
            await request("/staff/admin/recovery-runs","POST",{
              environment:text(f,"environment")||"staging-drill",
              backup_reference:text(f,"backup_reference"),
              rpo_seconds:Number(text(f,"rpo_seconds")||0),
              rto_seconds:Number(text(f,"rto_seconds")||60),
              revoked_session_ids:sess,
              notes:text(f,"notes"),
            });
            health.reload();
          }}>
            <div className="grid two">
              <label>演练环境<input name="environment" defaultValue="staging-drill" required/></label>
              <label>备份快照编号<input name="backup_reference" placeholder="pg-dump-20261107" required/></label>
            </div>
            <div className="grid two">
              <label>实测 RPO（秒）<input name="rpo_seconds" type="number" defaultValue="0" min={0} required/></label>
              <label>实测 RTO（秒）<input name="rto_seconds" type="number" defaultValue="45" min={0} required/></label>
            </div>
            <label>需重放撤销的会话 ID（逗号分隔，可选）<input name="revoked_session_ids"/></label>
            <label>恢复核验说明<textarea name="notes" rows={2}/></label>
          </Form>
        </div>
        <div>
          <Table headers={["演练编号","环境 / 快照","状态","RPO / RTO","重放与对账摘要","时间"]} rows={runs.map((r:Row)=>{
            const m=r.reconciliation??r.replay_manifest??{};
            const rec=m.payment_handover_reconciliation??{};
            return [
              <strong className="code">{r.id.slice(0,8)}</strong>,
              <span>{m.environment??"staging-drill"} · <span className="code">{m.backup_reference??"—"}</span></span>,
              <Tag>{m.verified?"verified":"warning"}</Tag>,
              <span>{m.rpo_seconds??0}s / {m.rto_seconds??0}s</span>,
              <span>重放会话 {m.replayed?.sessions_revoked??0} · 已付收费 {rec.paid_charges_verified??0} · 交接批次 {rec.shipments_handed_over_verified??0}</span>,
              stamp(r.finished_at??r.started_at),
            ];
          })} empty="暂无恢复演练记录。"/>
        </div>
      </div>
    </>}
  </Panel>;
}

const scenarioLabels:Record<string,string>={
  set_1_standard:"第 1 组：入仓建档 → 标准质检 → 报告发布 → 处置与交接",
  set_2_weak_network:"第 2 组：移动端/手持端弱网与上传重试、扫码回读与库位移动",
  set_3_return_retain:"第 3 组：退回商家、留样与合包/拆包发运",
  set_4_recovery_alerts:"第 4 组：退件实收、作业失败告警与恢复",
  three_carrier_30_items:"第 5 组：三承运商、30 件包裹与回执留痕实仓演练",
};

const gateLabels:Record<string,string>={
  warehouse_address:"唯一启用默认公共收件仓址",
  legal_terms:"4 类协议与须知均存在已发布生效版本",
  shipping_rates:"正式运费版本已发布",
  catalog_purity:"生产目录仅开放已准入 ACTIVE 品类",
  legal_entity_configured:"香港法律主体与客服邮箱已配置",
  recovery_drill_verified:"备份恢复与对账演练已验证",
  rehearsal_sets_completed:"5 组演练全部归档通过且完成复验",
  no_exhausted_jobs:"无耗尽重试的积压后台作业",
  oidc_configured:"Google / Microsoft OIDC 正式回调已就绪",
  postmark_live:"Postmark 正式发信通道已启用",
  stripe_live:"Stripe Live 密钥、Webhook 与收款开关已就绪",
  kuaidi100_live:"快递100 正式查询与 HTTPS 回调已就绪",
};

function LaunchReadinessAndRehearsalPanel() {
  const readiness=useLoad("/staff/admin/launch-readiness");
  const d=readiness.data;
  return <Panel title="实仓演练归档与生产上线门禁">
    <p className="muted">统一管理第 29 周 5 组实仓/预发布演练证据归档与复验（测试证据与生产证据严格分离）、第 30 周香港运营主体配置（附录 C.12）、在途订单/批次/库存预检，以及 §23 门禁逐项签署（缺任一项即锁定为预发布 staging_only）。</p>
    {readiness.error&&<ErrorBlock error={readiness.error}/>}
    {d&&<>
      <div className="metric-strip" aria-label="上线门禁摘要">
        <div className="metric"><span>当前生效运行模式</span><strong>{d.effective_mode==="production"?"正式生产 (production)":"预发布保护 (staging_only)"}</strong><small>{d.all_gates_satisfied?"§23 门禁全部满足":"缺 "+d.missing_gates.length+" 项维持预发布"}</small></div>
        <div className="metric"><span>演练场景覆盖</span><strong>{d.rehearsal_coverage.completed_scenarios.length} / {d.rehearsal_coverage.required_scenarios.length}</strong><small>已复验 {d.rehearsal_coverage.reverified_count} 组</small></div>
        <div className="metric"><span>在途订单 / 批次</span><strong>{d.in_flight_summary.in_flight_orders} / {d.in_flight_summary.in_flight_batches}</strong><small>在库实物 {d.in_flight_summary.stored_items} 件</small></div>
        <div className="metric"><span>香港运营主体</span><strong>{d.legal_entity?.entity_name??"待配置"}</strong><small>BR: {d.legal_entity?.br_number??"—"}</small></div>
      </div>

      <Table
        headers={["§23 上线门禁项","门禁代码","当前状态"]}
        rows={Object.entries(d.gates as Record<string,boolean>).map(([k,ok])=>[
          gateLabels[k]??k,
          <span className="code">{k}</span>,
          <Tag>{ok?"已就绪 (PASS)":"待补齐 (HOLD)"}</Tag>,
        ])}
      />

      <div className="ops-columns">
        <div>
          <Form label="归档实仓 / 预发布演练证据" run={async f=>{
            const carriers=text(f,"carrier_codes").split(",").map(s=>s.trim()).filter(Boolean);
            await request("/staff/admin/rehearsal-runs","POST",{
              scenario:text(f,"scenario"),
              environment:text(f,"environment"),
              media_count:Number(text(f,"media_count")||0),
              carrier_codes:carriers,
              reverified:f.get("reverified")==="on",
              passed:f.get("passed")==="on",
              notes:text(f,"notes"),
            });
            readiness.reload();
          }}>
            <label>演练场景<select name="scenario" defaultValue="set_1_standard">
              {Object.entries(scenarioLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
            <div className="grid two">
              <label>环境隔离标识<select name="environment" defaultValue="staging">
                <option value="staging">预发布隔离演练 (staging)</option>
                <option value="real_warehouse">实仓现场演练 (real_warehouse)</option>
              </select></label>
              <label>归档照片/PDF 证据数<input name="media_count" type="number" defaultValue="12" min={0} required/></label>
            </div>
            <label>涉及承运商编码（逗号分隔）<input name="carrier_codes" defaultValue="sf,yto,zto"/></label>
            <div className="grid two">
              <label><input type="checkbox" name="passed" defaultChecked/> 本组演练验收通过</label>
              <label><input type="checkbox" name="reverified" defaultChecked/> 已完成问题修复与复验</label>
            </div>
            <label>单号、包裹号、运单号与回执归档说明<textarea name="notes" rows={2} required minLength={4}/></label>
          </Form>

          <Form label="配置香港法律主体信息" run={async f=>{
            await request("/staff/admin/legal-entity","POST",{
              entity_name:text(f,"entity_name"),
              entity_address:text(f,"entity_address"),
              br_number:text(f,"br_number"),
              support_email:text(f,"support_email"),
            });
            readiness.reload();
          }}>
            <div className="grid two">
              <label>香港公司法定名称<input name="entity_name" defaultValue={d.legal_entity?.entity_name??"QC Warehouse Limited"} required/></label>
              <label>商业登记证号码 (BR No.)<input name="br_number" defaultValue={d.legal_entity?.br_number??""} placeholder="HK-BR-00000000" required/></label>
            </div>
            <div className="grid two">
              <label>香港注册/运营地址<input name="entity_address" defaultValue={d.legal_entity?.entity_address??""} required/></label>
              <label>官方客服与法务邮箱<input name="support_email" type="email" defaultValue={d.legal_entity?.support_email??"support@qcwarehouse.com"} required/></label>
            </div>
          </Form>
        </div>

        <div>
          <Form label="签署上线决定与首单开放控制" run={async f=>{
            await request("/staff/admin/launch-signoff","POST",{
              target_mode:text(f,"target_mode"),
              rollback_contact:text(f,"rollback_contact"),
              first_order_invite_enabled:f.get("first_order_invite_enabled")==="on",
              live_penny_test_ref:text(f,"live_penny_test_ref")||undefined,
              notes:text(f,"notes"),
            });
            readiness.reload();
          }}>
            <div className="grid two">
              <label>目标发布模式<select name="target_mode" defaultValue={d.signoff?.target_mode??"staging_only"}>
                <option value="staging_only">维持预发布 (staging_only)</option>
                <option value="production">申请开放正式生产 (production)</option>
              </select></label>
              <label>回退负责人与紧急联络方式<input name="rollback_contact" defaultValue={d.signoff?.rollback_contact??"ops-lead@qcwarehouse.com"} required/></label>
            </div>
            <div className="grid two">
              <label>真实小额付款/退款留证号（选填）<input name="live_penny_test_ref" defaultValue={d.signoff?.live_penny_test_ref??""}/></label>
              <label><input type="checkbox" name="first_order_invite_enabled" defaultChecked={Boolean(d.signoff?.first_order_invite_enabled)}/> 允许受邀客户首单跟进</label>
            </div>
            <label>门禁核对与签署结论<textarea name="notes" rows={2} required minLength={4} defaultValue={d.signoff?.notes??""}/></label>
          </Form>

          <Table
            headers={["演练场景","环境","证据数 / 承运商","复验 / 结论","归档摘要","时间"]}
            rows={(d.rehearsal_runs??[]).map((r:Row)=>[
              scenarioLabels[r.scenario]??r.scenario,
              <Tag>{r.environment}</Tag>,
              <span>{r.media_count} 份 · {(r.carrier_codes??[]).join(",")||"—"}</span>,
              <Tag>{r.passed?(r.reverified?"PASS + 已复验":"PASS"):"FAIL"}</Tag>,
              r.notes,
              stamp(r.recorded_at),
            ])}
            empty="尚未登记实仓或预发布演练记录。"
          />
        </div>
      </div>
    </>}
  </Panel>;
}
