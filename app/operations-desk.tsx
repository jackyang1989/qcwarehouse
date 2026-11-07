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
  </>;
}

function SystemHealthAndRecoveryPanel() {
  const health=useLoad("/staff/admin/system-health");
  const h=health.data;
  return <Panel title="系统健康、备份校验与恢复演练重放台（PAGE-M15 / TASK-130 / TASK-173）">
    <p className="muted">验证对象存储/私有媒体完整性，登记备份恢复演练并重放恢复时间点后的会话撤销、账号注销、解绑与退信抑制清单（T105），同时核对外部支付与出库交接一致性（T106）。</p>
    {health.error&&<ErrorBlock error={health.error}/>}
    {h&&<>
      <div className="metric-strip" aria-label="系统健康与备份">
        <div className="metric"><span>系统健康状态</span><strong>{h.healthy?"正常":"告警"}</strong><small>数据库连通正常</small></div>
        <div className="metric"><span>私有媒体完整性</span><strong>{h.storage.total_files - h.storage.missing_bytes_count} / {h.storage.total_files}</strong><small>缺失字节 {h.storage.missing_bytes_count}</small></div>
        <div className="metric"><span>积压作业 / 抑制邮箱</span><strong>{h.queues.exhausted_jobs} / {h.queues.suppressed_emails}</strong><small>开放事故 {h.queues.open_incidents}</small></div>
        <div className="metric"><span>恢复演练记录</span><strong>{(h.recent_recovery_runs??[]).length}</strong><small>RPO / RTO 审计</small></div>
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
          <Table headers={["演练编号","环境 / 快照","状态","RPO / RTO","重放与对账摘要","时间"]} rows={(h.recent_recovery_runs??[]).map((r:Row)=>{
            const m=r.replay_manifest??{};
            const rec=m.payment_handover_reconciliation??{};
            return [
              <strong className="code">{r.id.slice(0,8)}</strong>,
              <span>{r.environment} · <span className="code">{r.backup_reference}</span></span>,
              <Tag>{r.state}</Tag>,
              <span>{m.rpo_seconds??0}s / {m.rto_seconds??0}s</span>,
              <span>重放会话 {m.replayed?.sessions_revoked??0} · 已付收费 {rec.paid_charges_verified??0} · 交接批次 {rec.shipments_handed_over_verified??0}</span>,
              stamp(r.completed_at??r.started_at),
            ];
          })} empty="暂无恢复演练记录。"/>
        </div>
      </div>
    </>}
  </Panel>;
}
