import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import type { DB } from "../db";
import { appOrigin } from "./auth";
import { audit, guard, hash, one, role, uuid, type Actor } from "./common";
import { lookup, waybill } from "./intake";

export const labelPrintInputSchema = z
  .object({
    package_id: z.string().uuid().optional(),
    item_ids: z.array(z.string().uuid()).max(100).optional(),
    reprint_reason: z.string().trim().min(2).max(500).optional(),
  })
  .refine(v => Boolean(v.package_id || (v.item_ids && v.item_ids.length > 0)), {
    message: "Provide package_id or item_ids to print labels.",
  });

export const labelVerifyInputSchema = z.object({
  expected_code: z.string().trim().min(3).max(64),
  scanned_code: z.string().trim().min(3).max(64),
});

export async function scanWarehouseCode(db: DB, actor: Actor, rawCode: string, carrierCode?: string | null) {
  role(actor, "receiver", "warehouse_admin", "inspector", "reviewer");
  const code = rawCode.trim();
  guard(code.length >= 3 && code.length <= 80, "SCAN_CODE_INVALID", "Enter a valid package, item, or tracking code.", 422);

  if (/^P-[A-Z0-9-]{1,64}$/i.test(code)) {
    const normalized = code.toUpperCase();
    const pkg = (
      await db.query<{
        id: string;
        code: string;
        state: string;
        received_quantity: number;
        received_at: Date;
        location: string | null;
        tracking_norm: string | null;
      }>(
        `select p.id, p.code, p.state, p.received_quantity, p.received_at,
                sl.code as location, t.tracking_norm
         from packages p
         left join storage_locations sl on sl.id = p.location_id
         left join tracking_records t on t.package_id = p.id and t.direction = 'inbound' and t.closed_at is null
         where p.code = $1`,
        [normalized]
      )
    ).rows[0];
    guard(pkg, "NOT_FOUND", "Package code not found.", 404);
    const canIntake = actor.roles.some(r => ["receiver", "warehouse_admin"].includes(r));
    const allowed_actions = canIntake ? ["open_package", "unpack_items", "print_label"] : ["open_package"];
    return {
      kind: "package" as const,
      code: pkg.code,
      package_id: pkg.id,
      state: pkg.state,
      received_quantity: pkg.received_quantity,
      location: pkg.location,
      tracking_norm: pkg.tracking_norm,
      summary: `仓库已实收 · 已登记 ${pkg.received_quantity} 件${pkg.location ? " · 库位 " + pkg.location : ""}`,
      link: "/wh/packages/" + pkg.code,
      allowed_actions,
    };
  }

  if (/^S-[A-Za-z0-9-]{1,64}$/i.test(code)) {
    const item = (
      await db.query<{
        id: string;
        code: string;
        org_id: string | null;
        custody_state: string;
        identity_state: string;
        package_code: string;
        location: string | null;
        order_number: string | null;
        task_id: string | null;
      }>(
        `select w.id, w.code, w.org_id, w.custody_state, w.identity_state,
                p.code as package_code, sl.code as location, o.public_no as order_number,
                (select it.id from inspection_tasks it
                 where it.assignment_id = a.id and it.state <> 'VOID'
                 order by it.id limit 1) as task_id
         from warehouse_items w
         join packages p on p.id = w.package_id
         left join storage_locations sl on sl.id = w.location_id
         left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
         left join order_lines l on l.id = a.order_line_id
         left join orders o on o.id = l.order_id
         where upper(w.code) = upper($1)`,
        [code]
      )
    ).rows[0];
    guard(item, "NOT_FOUND", "Warehouse item code not found.", 404);
    const canIntake = actor.roles.some(r => ["receiver", "warehouse_admin"].includes(r));
    const canInspect = actor.roles.includes("inspector");
    const allowed_actions: string[] = ["open_item"];
    if (canIntake) {
      if (["received", "stored"].includes(item.custody_state)) allowed_actions.push("move_storage");
      if (item.org_id && !item.order_number) allowed_actions.push("assign_order_position");
      allowed_actions.push("print_label");
    }
    if (canInspect && item.task_id) {
      allowed_actions.push("open_inspection_task");
    }
    return {
      kind: "item" as const,
      code: item.code,
      item_id: item.id,
      custody_state: item.custody_state,
      identity_state: item.identity_state,
      location: item.location,
      package_code: item.package_code,
      order_number: item.order_number,
      task_id: item.task_id,
      summary: `${item.custody_state} · 库位 ${item.location ?? "未登记"}${item.order_number ? " · 委托 " + item.order_number : ""}`,
      link:
        canInspect && !canIntake && item.task_id
          ? "/wh/task/" + item.task_id
          : "/wh/samples/" + encodeURIComponent(item.code),
      allowed_actions,
    };
  }

  role(actor, "receiver", "warehouse_admin");
  const normalizedWaybill = waybill(code);
  const res = await lookup(db, actor, {
    tracking_no: normalizedWaybill,
    ...(carrierCode ? { carrier_code: carrierCode } : {}),
  });
  if (res.match_state === "ambiguous") {
    return {
      kind: "waybill" as const,
      code: normalizedWaybill,
      ...res,
      summary: "发现多个候选。请选择面单上的承运商后重新查询。",
      link: null,
      allowed_actions: ["select_carrier"],
    };
  }
  const pkgId = "package_id" in res ? (res.package_id as string | undefined) : undefined;
  const recCode = "receiving_code" in res ? (res.receiving_code as string | undefined) : undefined;
  const hasPackage = Boolean(pkgId);
  return {
    kind: "waybill" as const,
    code: normalizedWaybill,
    ...res,
    summary: hasPackage
      ? "仓库已有实收记录"
      : recCode
        ? `已匹配收件码 ${recCode}`
        : "待核验包裹归属（可先无预报隔离实收）",
    link: "/wh/intake?" + new URLSearchParams(pkgId ? { package: pkgId } : { tracking: normalizedWaybill }),
    allowed_actions: hasPackage ? ["open_package", "unpack_items"] : ["check_in"],
  };
}

function drawCodeMatrix(page: import("pdf-lib").PDFPage, code: string, x: number, y: number, size: number) {
  const digest = Buffer.from(hash(code), "hex");
  const grid = 15;
  const cell = size / grid;
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const finder =
        (r < 3 && c < 3) ||
        (r < 3 && c >= grid - 3) ||
        (r >= grid - 3 && c < 3);
      const bitIndex = (r * grid + c) % (digest.length * 8);
      const bit = (digest[Math.floor(bitIndex / 8)] >> (bitIndex % 8)) & 1;
      if (finder || bit === 1) {
        page.drawRectangle({
          x: x + c * cell,
          y: y + (grid - 1 - r) * cell,
          width: cell,
          height: cell,
          color: rgb(0.05, 0.08, 0.12),
        });
      }
    }
  }
}

export async function printLabels(
  db: DB,
  actor: Actor,
  input: z.infer<typeof labelPrintInputSchema>
) {
  role(actor, "receiver", "warehouse_admin");
  const targets: { target_type: "package" | "item"; id: string; code: string; entity_type: string }[] = [];

  if (input.package_id) {
    const pkg = await one<{ id: string; code: string }>(db, "select id, code from packages where id=$1", [input.package_id]);
    targets.push({ target_type: "package", id: pkg.id, code: pkg.code, entity_type: "packages" });
  }
  if (input.item_ids?.length) {
    const uniqueIds = [...new Set(input.item_ids)];
    const { rows } = await db.query<{ id: string; code: string }>(
      "select id, code from warehouse_items where id = any($1::uuid[]) order by code",
      [uniqueIds]
    );
    guard(rows.length === uniqueIds.length, "NOT_FOUND", "One or more warehouse items were not found.", 404);
    for (const row of rows) {
      targets.push({ target_type: "item", id: row.id, code: row.code, entity_type: "warehouse_items" });
    }
  }

  const labels: {
    target_type: "package" | "item";
    target_id: string;
    code: string;
    qr_payload: string;
    reprint: boolean;
    print_count: number;
  }[] = [];

  for (const t of targets) {
    const prev = await one<{ n: number }>(
      db,
      "select count(*)::int n from audit_events where entity_type=$1 and entity_id=$2 and action in ('print_label','reprint_label')",
      [t.entity_type, t.id]
    );
    const isReprint = prev.n > 0;
    if (isReprint) {
      guard(
        Boolean(input.reprint_reason && input.reprint_reason.trim().length >= 2),
        "REPRINT_REASON_REQUIRED",
        "Provide a reason when reprinting an existing label.",
        422
      );
    }
    labels.push({
      target_type: t.target_type,
      target_id: t.id,
      code: t.code,
      qr_payload: t.code,
      reprint: isReprint,
      print_count: prev.n + 1,
    });
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const label of labels) {
    const page = pdf.addPage([240, 140]);
    drawCodeMatrix(page, label.code, 16, 25, 90);
    page.drawText(label.code, {
      x: 118,
      y: 72,
      size: 14,
      font,
      color: rgb(0.05, 0.08, 0.12),
    });
    page.drawText(label.target_type === "package" ? "PACKAGE" : "SAMPLE", {
      x: 118,
      y: 52,
      size: 9,
      font,
      color: rgb(0.35, 0.4, 0.45),
    });
  }
  const pdfBytes = Buffer.from(await pdf.save());
  const printId = uuid();
  const fileKey = "labels/" + printId;
  await db.query("insert into private_files(key,data,mime) values($1,$2,'application/pdf')", [fileKey, pdfBytes]);

  for (const [idx, t] of targets.entries()) {
    const meta = labels[idx];
    await audit(db, actor, meta.reprint ? "reprint_label" : "print_label", t.entity_type, t.id, {
      print_id: printId,
      code: t.code,
      print_count: meta.print_count,
      ...(input.reprint_reason ? { reprint_reason: input.reprint_reason } : {}),
    });
  }

  return {
    print_id: printId,
    pdf_url: `${appOrigin()}/api/v1/staff/labels/${printId}/file`,
    labels,
  };
}

export async function readLabelPdf(db: DB, actor: Actor, printId: string) {
  role(actor, "receiver", "warehouse_admin", "inspector", "super_admin");
  return one<{ data: Buffer; mime: string }>(db, "select data,mime from private_files where key=$1", ["labels/" + printId]);
}

export async function verifyLabelReadback(
  db: DB,
  actor: Actor,
  input: z.infer<typeof labelVerifyInputSchema>
) {
  role(actor, "receiver", "warehouse_admin", "inspector");
  const expected = input.expected_code.trim().toUpperCase();
  const scanned = input.scanned_code.trim().toUpperCase();
  guard(expected === scanned, "LABEL_READBACK_MISMATCH", "Scanned label code does not match the expected object code.", 409);

  if (expected.startsWith("P-")) {
    const pkg = await one<{ id: string; code: string }>(db, "select id, code from packages where upper(code)=$1", [expected]);
    await audit(db, actor, "verify_label_readback", "packages", pkg.id, { code: pkg.code });
    return { verified: true, target_type: "package" as const, target_id: pkg.id, code: pkg.code };
  }
  if (expected.startsWith("S-")) {
    const item = await one<{ id: string; code: string }>(db, "select id, code from warehouse_items where upper(code)=$1", [expected]);
    await audit(db, actor, "verify_label_readback", "warehouse_items", item.id, { code: item.code });
    return { verified: true, target_type: "item" as const, target_id: item.id, code: item.code };
  }
  guard(false, "SCAN_CODE_INVALID", "Label verification requires a P- or S- internal code.", 422);
}
