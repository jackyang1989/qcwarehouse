import { createHmac, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { pool, type DB } from "../db";
import { appOrigin } from "./auth";
import { Problem, audit, guard, hash, one, organization, role, uuid, type Actor } from "./common";
import { canReadCasePhoto } from "./tickets";

export const mediaKindSchema = z.enum([
  "intake_outer",
  "intake_open",
  "shot",
  "defect",
  "attachment",
  "label_photo",
  "dispatch",
]);

export const mediaMimeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export const uploadUrlInputSchema = z.object({
  kind: mediaKindSchema,
  mime: mediaMimeSchema,
  size_bytes: z.number().int().min(1).max(25_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(v => v.toLowerCase()),
  order_id: z.string().uuid().optional(),
  package_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  item_id: z.string().uuid().optional(),
  component: z.string().trim().min(1).max(64).optional(),
  shot_code: z.string().trim().min(1).max(64).optional(),
  point_code: z.string().trim().min(1).max(64).optional(),
  result_id: z.string().uuid().optional(),
});

function mediaPepper() {
  const value = process.env.AUTH_OTP_PEPPER;
  guard(value && value.length >= 32, "AUTH_UNAVAILABLE", "Authentication configuration is incomplete.", 503);
  return value;
}

export function mediaUploadSignature(
  mediaId: string,
  uploaderId: string,
  mime: string,
  sizeBytes: number,
  sha256: string,
  expires: number
) {
  return createHmac("sha256", mediaPepper())
    .update(`media-put:${mediaId}:${uploaderId}:${mime}:${sizeBytes}:${sha256}:${expires}`)
    .digest("base64url");
}

export function verifyMediaUploadSignature(
  mediaId: string,
  uploaderId: string,
  mime: string,
  sizeBytes: number,
  sha256: string,
  expiry: string,
  signature: string
) {
  const expires = Number(expiry);
  const expected = mediaUploadSignature(mediaId, uploaderId, mime, sizeBytes, sha256, expires);
  guard(
    Number.isSafeInteger(expires) &&
      expires > Date.now() &&
      /^[A-Za-z0-9_-]{43}$/.test(signature) &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
    "UPLOAD_URL_EXPIRED",
    "The upload link has expired or is invalid.",
    403
  );
}

export function mediaReadSignature(actorId: string, mediaId: string, variant: "original" | "thumb", expires: number) {
  return createHmac("sha256", mediaPepper())
    .update(`media-read:${actorId}:${mediaId}:${variant}:${expires}`)
    .digest("base64url");
}

export function verifyMediaReadSignature(
  actorId: string,
  mediaId: string,
  variant: "original" | "thumb",
  expiry: string,
  signature: string
) {
  const expires = Number(expiry);
  const expected = mediaReadSignature(actorId, mediaId, variant, expires);
  guard(
    Number.isSafeInteger(expires) &&
      expires > Date.now() &&
      /^[A-Za-z0-9_-]{43}$/.test(signature) &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
    "DOWNLOAD_EXPIRED",
    "Request a new media access link.",
    403
  );
}

function parseExifDate(exifBuffer?: Buffer): Date | null {
  if (!exifBuffer) return null;
  const raw = exifBuffer.toString("latin1");
  const match = raw.match(/\b(20\d{2}):([01]\d):([0-3]\d) ([0-2]\d):([0-5]\d):([0-5]\d)\b/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function processImageBytes(bytes: Buffer) {
  let fullData: Buffer;
  let thumbData: Buffer;
  let width: number | null = null;
  let height: number | null = null;
  let capturedAt: Date | null = null;
  try {
    const base = sharp(bytes, { limitInputPixels: 30_000_000 });
    const meta = await base.metadata();
    capturedAt = parseExifDate(meta.exif);
    const fullResult = await sharp(bytes, { limitInputPixels: 30_000_000 })
      .rotate()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86 })
      .toBuffer({ resolveWithObject: true });
    fullData = fullResult.data;
    width = fullResult.info.width ?? meta.width ?? null;
    height = fullResult.info.height ?? meta.height ?? null;
    thumbData = await sharp(fullData, { limitInputPixels: 30_000_000 })
      .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    throw new Problem("FILE_INVALID", "Upload a valid raster image.", 422);
  }
  return { fullData, thumbData, width, height, capturedAt };
}

export async function createMediaUploadUrl(
  db: DB,
  actor: Actor,
  input: z.infer<typeof uploadUrlInputSchema>
) {
  let org: string | null = actor.kind === "customer" ? organization(actor) : null;
  if (actor.kind === "customer") {
    guard(input.kind === "attachment", "FORBIDDEN", "Only customer attachments can be uploaded.", 403);
    guard(!input.package_id && !input.task_id && !input.result_id, "FORBIDDEN", "Invalid upload scope for customer.", 403);
    if (input.order_id) {
      const ord = await one<{ org_id: string }>(db, "select org_id from orders where id=$1", [input.order_id]);
      guard(ord.org_id === org, "NOT_FOUND", "Order not found.", 404);
    }
    if (input.item_id) {
      const item = await one<{ org_id: string | null }>(db, "select org_id from warehouse_items where id=$1", [input.item_id]);
      guard(item.org_id === org, "NOT_FOUND", "Item not found.", 404);
    }
  } else {
    role(actor, "receiver", "inspector", "warehouse_admin");
    const rate = await one<{ n: number }>(
      db,
      "select count(*)::int n from audit_events where actor_id=$1 and action='issue_media_upload_url' and at>now()-interval '1 minute'",
      [actor.id]
    );
    guard(rate.n < 60, "UPLOAD_RATE_LIMIT", "Too many upload requests. Wait a moment and retry.", 429);
    if (input.order_id) {
      const ord = await one<{ org_id: string }>(db, "select org_id from orders where id=$1", [input.order_id]);
      org = org ?? ord.org_id;
      guard(org === ord.org_id, "EVIDENCE_MISMATCH", "Order scope does not match.", 422);
    }
    if (input.package_id) {
      const pkg = await one<{ org_id: string | null }>(db, "select org_id from packages where id=$1", [input.package_id]);
      if (pkg.org_id) {
        org = org ?? pkg.org_id;
        guard(org === pkg.org_id, "EVIDENCE_MISMATCH", "Package scope does not match.", 422);
      }
    }
    if (input.task_id) {
      const t = await one<{ org_id: string }>(
        db,
        "select l.org_id from inspection_tasks t join order_lines l on l.id=t.order_line_id where t.id=$1",
        [input.task_id]
      );
      org = org ?? t.org_id;
      guard(org === t.org_id, "EVIDENCE_MISMATCH", "Task scope does not match.", 422);
    }
    if (input.item_id) {
      const item = await one<{ org_id: string | null }>(db, "select org_id from warehouse_items where id=$1", [input.item_id]);
      if (item.org_id) {
        org = org ?? item.org_id;
        guard(org === item.org_id, "EVIDENCE_MISMATCH", "Item scope does not match.", 422);
      }
    }
  }

  const id = uuid();
  const objectKey = "media/" + id;
  const thumbKey = "thumb/" + id;
  await db.query(
    `insert into media_assets(
       id, org_id, order_id, item_id, package_id, task_id, kind,
       component, shot_code, point_code, result_id,
       object_key, thumb_key, mime, size_bytes, sha256, status, uploaded_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17)`,
    [
      id,
      org,
      input.order_id ?? null,
      input.item_id ?? null,
      input.package_id ?? null,
      input.task_id ?? null,
      input.kind,
      input.component ?? null,
      input.shot_code ?? null,
      input.point_code ?? null,
      input.result_id ?? null,
      objectKey,
      thumbKey,
      input.mime,
      input.size_bytes,
      input.sha256,
      actor.id,
    ]
  );
  await audit(db, actor, "issue_media_upload_url", "media_assets", id, {
    kind: input.kind,
    mime: input.mime,
    size_bytes: input.size_bytes,
  });

  const expires = Date.now() + 10 * 60_000;
  const sig = mediaUploadSignature(id, actor.id, input.mime, input.size_bytes, input.sha256, expires);
  const query = new URLSearchParams({ expires: String(expires), sig });
  return {
    media_id: id,
    upload_url: `${appOrigin()}/api/v1/media/${id}/put?${query}`,
    expires_at: new Date(expires).toISOString(),
  };
}

export async function putMediaStaging(
  db: DB,
  mediaId: string,
  expiresStr: string,
  sig: string,
  bytes: Buffer
) {
  const m = await one<{
    id: string;
    uploaded_by: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    status: string;
  }>(db, "select id,uploaded_by,mime,size_bytes,sha256,status from media_assets where id=$1 for update", [mediaId]);
  verifyMediaUploadSignature(mediaId, m.uploaded_by, m.mime, m.size_bytes, m.sha256, expiresStr, sig);
  guard(m.status === "pending", "MEDIA_ALREADY_COMPLETED", "This media upload is already completed or rejected.", 409);
  guard(bytes.length > 0 && bytes.length <= 25_000_000, "FILE_INVALID", "Upload a file up to 25 MB.", 422);

  const stagingKey = "staging/media/" + mediaId;
  await db.query(
    `insert into private_files(key,data,mime) values($1,$2,$3)
     on conflict(key) do update set data=excluded.data,mime=excluded.mime,created_at=now()`,
    [stagingKey, bytes, m.mime]
  );
  return { media_id: mediaId, staged_bytes: bytes.length };
}

export async function completeMediaUpload(db: Pick<DB, "query">, actor: Actor, mediaId: string) {
  const m = await one<{
    id: string;
    uploaded_by: string;
    object_key: string;
    thumb_key: string | null;
    mime: string;
    size_bytes: number;
    sha256: string;
    status: string;
    width: number | null;
    height: number | null;
    captured_at: Date | null;
  }>(db, "select * from media_assets where id=$1 and uploaded_by=$2", [mediaId, actor.id]);

  if (m.status === "ready") {
    return {
      id: m.id,
      status: "ready",
      sha256: m.sha256,
      width: m.width,
      height: m.height,
      thumb_key: m.thumb_key,
      captured_at: m.captured_at,
    };
  }
  guard(m.status === "pending", "MEDIA_REJECTED", "This media upload was rejected.", 422);

  const stagingKey = "staging/media/" + mediaId;
  const staged = (await db.query<{ data: Buffer }>("select data from private_files where key=$1", [stagingKey])).rows[0];
  guard(staged, "MEDIA_NOT_READY", "Upload the file bytes before completing.", 409);

  const actualSha = hash(staged.data);
  if (actualSha !== m.sha256 || staged.data.length !== m.size_bytes) {
    await pool.query("delete from private_files where key=$1", [stagingKey]);
    await pool.query("update media_assets set status='rejected' where id=$1", [mediaId]);
    throw new Problem("MEDIA_CHECKSUM_MISMATCH", "Uploaded file sha256 or byte length does not match declaration.", 422);
  }

  let processed: Awaited<ReturnType<typeof processImageBytes>>;
  try {
    processed = await processImageBytes(staged.data);
  } catch (err) {
    await pool.query("delete from private_files where key=$1", [stagingKey]);
    await pool.query("update media_assets set status='rejected' where id=$1", [mediaId]);
    throw err;
  }

  const thumbKey = m.thumb_key ?? "thumb/" + mediaId;
  await db.query(
    `insert into private_files(key,data,mime) values($1,$2,'image/jpeg')
     on conflict(key) do update set data=excluded.data,mime=excluded.mime`,
    [m.object_key, processed.fullData]
  );
  await db.query(
    `insert into private_files(key,data,mime) values($1,$2,'image/jpeg')
     on conflict(key) do update set data=excluded.data,mime=excluded.mime`,
    [thumbKey, processed.thumbData]
  );
  await db.query("delete from private_files where key=$1", [stagingKey]);

  const updated = await one<{
    id: string;
    status: string;
    sha256: string;
    width: number | null;
    height: number | null;
    thumb_key: string;
    captured_at: Date | null;
  }>(
    db,
    `update media_assets
     set status='ready', mime='image/jpeg', size_bytes=$2, width=$3, height=$4, thumb_key=$5, captured_at=coalesce($6,captured_at)
     where id=$1
     returning id, status, sha256, width, height, thumb_key, captured_at`,
    [mediaId, processed.fullData.length, processed.width, processed.height, thumbKey, processed.capturedAt]
  );
  await audit(db, actor, "complete_media_upload", "media_assets", mediaId, {
    sha256: m.sha256,
    width: processed.width,
    height: processed.height,
  });
  return updated;
}

export async function cleanupStaleMediaUploads(db: DB) {
  const { rows } = await db.query<{ id: string; object_key: string; thumb_key: string | null }>(
    `delete from media_assets
     where status='pending' and created_at < now() - interval '24 hours'
     returning id, object_key, thumb_key`
  );
  if (rows.length > 0) {
    const keys = rows.flatMap(r => ["staging/media/" + r.id, r.object_key, ...(r.thumb_key ? [r.thumb_key] : [])]);
    await db.query("delete from private_files where key = any($1::text[])", [keys]);
  }
  return { cleaned: rows.length, media_ids: rows.map(r => r.id) };
}

export async function authorizeMediaRead(db: DB, actor: Actor, id: string) {
  const m = await one<{
    id: string;
    org_id: string | null;
    package_id: string | null;
    task_id: string | null;
    result_id: string | null;
    kind: string;
    object_key: string;
    thumb_key: string | null;
    mime: string;
    sha256: string;
    width: number | null;
    height: number | null;
    captured_at: Date | null;
    uploaded_by: string | null;
  }>(db, "select * from media_assets where id=$1 and status='ready'", [id]);

  if (m.kind === "attachment" && (await canReadCasePhoto(db, actor, id))) {
    return m;
  }
  if (actor.kind === "customer") {
    const org = organization(actor);
    if (m.kind === "attachment" && m.org_id === org && m.uploaded_by === actor.id) {
      return m;
    }
    guard(m.org_id === org && m.result_id, "NOT_FOUND", "Photo not found.", 404);
    await one(
      db,
      `select v.id from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
       where o.org_id=$2 and v.state in ('published','superseded') and exists(
         select 1 from jsonb_array_elements(v.snapshot->'sections') s, jsonb_array_elements(s->'results') x
         where (x->'evidence_ids') ? $1
       ) limit 1`,
      [id, org]
    );
  } else {
    role(actor, "receiver", "warehouse_admin", "inspector", "reviewer", "support", "super_admin");
    const claimProof =
      m.kind === "attachment" &&
      actor.roles.some(r => ["support", "super_admin"].includes(r)) &&
      (await db.query("select 1 from tickets where category='identity_unclear' and details->>'proof_id'=$1", [id])).rowCount;
    const orderAttachment =
      m.kind === "attachment" &&
      actor.roles.some(r => ["inspector", "reviewer", "support", "warehouse_admin", "super_admin"].includes(r)) &&
      (
        await db.query(
          "select 1 from order_lines where (attributes->'attachment_ids') ? $1 or exists(select 1 from jsonb_array_elements(draft_items) item where (item->'attachment_ids') ? $1)",
          [id]
        )
      ).rowCount;
    const claimOuter =
      m.kind === "intake_outer" &&
      m.org_id === null &&
      actor.roles.some(r => ["support", "super_admin"].includes(r)) &&
      (
        await db.query(
          `select 1 from tracking_records t join tickets k on k.details->>'tracking_no'=t.tracking_norm
           and coalesce(t.carrier_code,k.details->>'carrier_code')=k.details->>'carrier_code'
           where t.package_id=$1 and t.closed_at is null and t.org_id is null
           and k.category='identity_unclear' and k.state='open' and k.details ? 'proof_id'`,
          [m.package_id]
        )
      ).rowCount;
    guard(
      claimProof ||
        orderAttachment ||
        claimOuter ||
        m.uploaded_by === actor.id ||
        (actor.roles.includes("super_admin") && m.kind !== "attachment") ||
        (actor.roles.includes("warehouse_admin") && m.kind !== "attachment") ||
        (actor.roles.includes("reviewer") && m.task_id),
      "NOT_FOUND",
      "Photo not found.",
      404
    );
  }
  return m;
}

export async function createMediaReadUrl(db: DB, actor: Actor, id: string) {
  const m = await authorizeMediaRead(db, actor, id);
  const expires = Date.now() + 10 * 60_000;
  const origSig = mediaReadSignature(actor.id, id, "original", expires);
  const thumbSig = mediaReadSignature(actor.id, id, "thumb", expires);
  const origin = appOrigin();
  return {
    id: m.id,
    url: `${origin}/api/v1/media/${id}?${new URLSearchParams({ variant: "original", expires: String(expires), sig: origSig })}`,
    thumb_url: `${origin}/api/v1/media/${id}?${new URLSearchParams({ variant: "thumb", expires: String(expires), sig: thumbSig })}`,
    expires_at: new Date(expires).toISOString(),
    sha256: m.sha256,
    width: m.width,
    height: m.height,
    captured_at: m.captured_at,
  };
}

export async function readMediaBinary(
  db: DB,
  actor: Actor,
  id: string,
  variant: "original" | "thumb" = "original",
  expires?: string | null,
  sig?: string | null
) {
  if (expires && sig) {
    verifyMediaReadSignature(actor.id, id, variant, expires, sig);
  }
  const m = await authorizeMediaRead(db, actor, id);
  const key = variant === "thumb" && m.thumb_key ? m.thumb_key : m.object_key;
  const file = (await db.query<{ data: Buffer; mime: string }>("select data,mime from private_files where key=$1", [key])).rows[0];
  if (!file && key !== m.object_key) {
    return one<{ data: Buffer; mime: string }>(db, "select data,mime from private_files where key=$1", [m.object_key]);
  }
  guard(file, "NOT_FOUND", "Photo not found.", 404);
  return file;
}
