import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const TONES = ["light", "medium", "tan", "deep"] as const;
export const VIEWS = ["01", "02", "03", "04"] as const;
export const VIEW_LABELS = {
  "01": "Open hands",
  "02": "Right hand",
  "03": "Thumb visible",
  "04": "Left hand",
} as const;

type Tone = (typeof TONES)[number];
type View = (typeof VIEWS)[number];

type StyleRow = {
  id: string;
  shopify_product_handle: string | null;
  shopify_variant_id: string | null;
  label: string;
  category: string | null;
  description: string | null;
  price_text: string | null;
  cover_r2_key: string | null;
  plan_r2_key: string | null;
  status: string;
  sort_order: number;
  updated_at: string;
};

type AssetRow = {
  id: string;
  style_id: string;
  kind: string;
  tone: string | null;
  view: string | null;
  r2_key: string;
  width: number | null;
  height: number | null;
  qa_status: string;
  visual_status: string;
  version: string | null;
  updated_at: string;
};

type Actor = { email: string };
type Dimensions = { width: number; height: number };
type UploadKind = "result" | "cover";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let jwksUrl = "";
let jwks: JWTVerifyGetKey | undefined;

function resultKey(style: string, tone: Tone, view: View): string {
  return `tryon/results/${style}-${tone}-${view}.webp`;
}

function iconKey(style: string): string {
  return `tryon/icons/${style}-light-icon.webp`;
}

function adminAssetUrl(key: string): string {
  return `/api/assets/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function isStyle(value: string): boolean {
  return /^\d{3}$/.test(value);
}

function isTone(value: string): value is Tone {
  return (TONES as readonly string[]).includes(value);
}

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

function requireStyle(value: string): string {
  if (!isStyle(value)) {
    throw new HttpError(400, "invalid_style", "款式编号必须是 3 位数字，例如 001。");
  }
  return value;
}

function cleanEtag(value: string): string {
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

function securityHeaders(headers = new Headers()): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return headers;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = securityHeaders(new Headers(init.headers));
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

function withStaticSecurity(response: Response): Response {
  const secured = new Response(response.body, response);
  securityHeaders(secured.headers);
  secured.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  return secured;
}

function isLocalRequest(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
}

async function authenticate(request: Request, env: Env): Promise<Actor> {
  const url = new URL(request.url);
  const developmentEmail = (env as Env & { DEV_AUTH_EMAIL?: string }).DEV_AUTH_EMAIL;
  if (developmentEmail || isLocalRequest(url)) {
    return {
      email: request.headers.get("Cf-Access-Authenticated-User-Email") || developmentEmail || "local-operator@example.com",
    };
  }

  const teamDomain = env.TEAM_DOMAIN.replace(/\/$/, "");
  const policyAud: string = env.POLICY_AUD;
  if (teamDomain.includes("REPLACE_ME") || policyAud === "REPLACE_ME") {
    throw new HttpError(503, "access_not_configured", "Cloudflare Access 尚未配置。");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new HttpError(401, "access_token_missing", "缺少 Cloudflare Access 身份令牌。");
  }

  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  if (!jwks || jwksUrl !== certsUrl) {
    jwksUrl = certsUrl;
    jwks = createRemoteJWKSet(new URL(certsUrl));
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: policyAud,
    });
    if (typeof payload.email !== "string" || !payload.email) {
      throw new Error("JWT has no email claim");
    }
    return { email: payload.email };
  } catch (error) {
    console.warn(JSON.stringify({ event: "access_denied", reason: String(error) }));
    throw new HttpError(401, "access_token_invalid", "Cloudflare Access 身份令牌无效或已过期。");
  }
}

function enforceSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    throw new HttpError(403, "cross_origin_denied", "拒绝跨站写入请求。");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "cross_site_denied", "拒绝跨站写入请求。");
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required", "请求必须使用 application/json。");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > 65_536) throw new HttpError(413, "json_too_large", "JSON 请求过大。");
  const text = await request.text();
  if (text.length > 65_536) throw new HttpError(413, "json_too_large", "JSON 请求过大。");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 内容无效。");
  }
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_text", "字段格式无效。");
  const result = value.trim();
  if (result.length > max) throw new HttpError(400, "text_too_long", `字段不能超过 ${max} 个字符。`);
  return result || null;
}

function requiredText(value: unknown, max: number, field: string): string {
  const result = optionalText(value, max);
  if (!result) throw new HttpError(400, "required_field", `${field} 不能为空。`);
  return result;
}

function boundedCount(value: unknown, max = 17): number {
  const parsed = typeof value === "number" ? value : 0;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new HttpError(400, "invalid_count", "上传计数无效。");
  }
  return parsed;
}

async function readBodyBounded(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "image_too_large", `图片不能超过 ${Math.floor(maxBytes / 1_048_576)} MB。`);
  }
  if (!request.body) throw new HttpError(400, "empty_image", "没有收到图片内容。");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("image_too_large");
      throw new HttpError(413, "image_too_large", `图片不能超过 ${Math.floor(maxBytes / 1_048_576)} MB。`);
    }
    chunks.push(value);
  }
  if (!size) throw new HttpError(400, "empty_image", "图片内容为空。");
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0);
  return value;
}

export function parseWebPDimensions(buffer: ArrayBuffer): Dimensions {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new HttpError(415, "invalid_webp", "文件不是有效的 WebP 图片。");
  }
  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > bytes.length) break;

    if (fourcc === "VP8X" && length >= 10) {
      const width = 1 + (bytes[data + 4]! | (bytes[data + 5]! << 8) | (bytes[data + 6]! << 16));
      const height = 1 + (bytes[data + 7]! | (bytes[data + 8]! << 8) | (bytes[data + 9]! << 16));
      return { width, height };
    }
    if (
      fourcc === "VP8 " &&
      length >= 10 &&
      bytes[data + 3] === 0x9d &&
      bytes[data + 4] === 0x01 &&
      bytes[data + 5] === 0x2a
    ) {
      return {
        width: view.getUint16(data + 6, true) & 0x3fff,
        height: view.getUint16(data + 8, true) & 0x3fff,
      };
    }
    if (fourcc === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      const b1 = bytes[data + 1]!;
      const b2 = bytes[data + 2]!;
      const b3 = bytes[data + 3]!;
      const b4 = bytes[data + 4]!;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    offset = data + length + (length % 2);
  }
  throw new HttpError(415, "unsupported_webp", "无法读取这张 WebP 图片的尺寸。");
}

async function listObjects(env: Env, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const options: R2ListOptions = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await env.tryon_assets.list(options);
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function headObjects(env: Env, keys: string[]): Promise<Map<string, R2Object | null>> {
  const result = new Map<string, R2Object | null>();
  for (let offset = 0; offset < keys.length; offset += 6) {
    const group = keys.slice(offset, offset + 6);
    const objects = await Promise.all(group.map((key) => env.tryon_assets.head(key)));
    group.forEach((key, index) => result.set(key, objects[index] ?? null));
  }
  return result;
}

function serializeObject(_env: Env, object: R2Object | null): Record<string, unknown> | null {
  if (!object) return null;
  return {
    key: object.key,
    etag: object.etag,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
    width: Number(object.customMetadata?.width || 0) || null,
    height: Number(object.customMetadata?.height || 0) || null,
    url: adminAssetUrl(object.key),
  };
}

async function serveAdminAsset(request: Request, env: Env, encodedKey: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    throw new HttpError(400, "invalid_asset_key", "资源路径编码无效。");
  }
  const resultAsset = /^tryon\/results\/\d{3}-(light|medium|tan|deep)-(01|02|03|04)\.webp$/.test(key);
  const iconAsset = /^tryon\/icons\/\d{3}-light-icon\.webp$/.test(key);
  if (!resultAsset && !iconAsset) {
    throw new HttpError(400, "invalid_asset_key", "只允许预览试戴结果图和缩略图。");
  }
  const object = await env.tryon_assets.get(key, {
    onlyIf: request.headers,
  });
  if (!object) throw new HttpError(404, "asset_not_found", "图片不存在。");
  if (!("body" in object)) {
    return new Response(null, { status: 304, headers: securityHeaders(new Headers({ "Cache-Control": "private, no-cache" })) });
  }
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "image/webp");
  headers.set("Cache-Control", "private, no-cache, must-revalidate");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function stateFor(object: R2Object | null, metadata: AssetRow | undefined): string {
  if (object && metadata) return "healthy";
  if (object) return "object_only";
  if (metadata) return "metadata_only";
  return "missing";
}

async function getStyle(env: Env, style: string): Promise<StyleRow | null> {
  return env.TRYON_DB.prepare("SELECT * FROM tryon_styles WHERE id = ?").bind(style).first<StyleRow>();
}

async function requireExistingStyle(env: Env, style: string): Promise<StyleRow> {
  const row = await getStyle(env, style);
  if (!row) throw new HttpError(404, "style_not_found", `款式 ${style} 不存在，请先新建款式。`);
  return row;
}

async function listStyles(env: Env): Promise<Response> {
  const [dbResult, resultObjects, iconObjects] = await Promise.all([
    env.TRYON_DB.prepare("SELECT * FROM tryon_styles ORDER BY sort_order, id").all<StyleRow>(),
    listObjects(env, "tryon/results/"),
    listObjects(env, "tryon/icons/"),
  ]);
  const dbRows = new Map(dbResult.results.map((row) => [row.id, row]));
  const counts = new Map<string, number>();
  const styleIds = new Set(dbRows.keys());
  for (const object of resultObjects) {
    const match = /^tryon\/results\/(\d{3})-(light|medium|tan|deep)-(01|02|03|04)\.webp$/.exec(object.key);
    if (!match?.[1]) continue;
    styleIds.add(match[1]);
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  const iconIds = new Set<string>();
  for (const object of iconObjects) {
    const match = /^tryon\/icons\/(\d{3})-light-icon\.webp$/.exec(object.key);
    if (!match?.[1]) continue;
    styleIds.add(match[1]);
    iconIds.add(match[1]);
  }
  const styles = [...styleIds]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id) => {
      const row = dbRows.get(id);
      return {
        id,
        label: row?.label || `Style ${id}`,
        status: row?.status || "unindexed",
        category: row?.category || null,
        resultCount: counts.get(id) || 0,
        hasThumbnail: iconIds.has(id),
        hasMetadata: Boolean(row),
        updatedAt: row?.updated_at || null,
      };
    });
  return json({ styles, tones: TONES, views: VIEWS, viewLabels: VIEW_LABELS });
}

async function styleStatusData(env: Env, style: string): Promise<Record<string, unknown>> {
  requireStyle(style);
  const [row, metadataResult] = await Promise.all([
    getStyle(env, style),
    env.TRYON_DB.prepare("SELECT * FROM tryon_assets WHERE style_id = ?").bind(style).all<AssetRow>(),
  ]);
  const keys = TONES.flatMap((tone) => VIEWS.map((view) => resultKey(style, tone, view)));
  const coverKey = iconKey(style);
  const heads = await headObjects(env, [...keys, coverKey]);
  const metadataByKey = new Map(metadataResult.results.map((asset) => [asset.r2_key, asset]));
  const cells = TONES.flatMap((tone) =>
    VIEWS.map((view) => {
      const key = resultKey(style, tone, view);
      const object = heads.get(key) || null;
      const metadata = metadataByKey.get(key);
      return {
        tone,
        view,
        viewLabel: VIEW_LABELS[view],
        key,
        state: stateFor(object, metadata),
        object: serializeObject(env, object),
        metadata: metadata || null,
      };
    }),
  );
  const thumbnailObject = heads.get(coverKey) || null;
  const thumbnailMetadata = metadataByKey.get(coverKey);
  return {
    style: row,
    existsInD1: Boolean(row),
    resultCount: cells.filter((cell) => cell.object).length,
    missingCount: cells.filter((cell) => !cell.object).length,
    cells,
    thumbnail: {
      key: coverKey,
      state: stateFor(thumbnailObject, thumbnailMetadata),
      object: serializeObject(env, thumbnailObject),
      metadata: thumbnailMetadata || null,
    },
  };
}

async function createStyle(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const id = requireStyle(requiredText(body.id, 3, "款式编号"));
  if (await getStyle(env, id)) throw new HttpError(409, "style_exists", `款式 ${id} 已存在。`);
  const label = requiredText(body.label ?? `Style ${id}`, 120, "款式名称");
  const category = optionalText(body.category, 120) ?? "Try-On";
  const description = optionalText(body.description, 2_000);
  const productHandle = optionalText(body.shopifyProductHandle, 255);
  const variantId = optionalText(body.shopifyVariantId, 255);
  const maxOrder = await env.TRYON_DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM tryon_styles").first<{ value: number }>();
  const now = new Date().toISOString();
  await env.TRYON_DB.prepare(
    `INSERT INTO tryon_styles (
      id, shopify_product_handle, shopify_variant_id, label, category,
      description, price_text, cover_r2_key, plan_r2_key, status, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'draft', ?, ?)`,
  )
    .bind(id, productHandle, variantId, label, category, description, iconKey(id), (maxOrder?.value || 0) + 10, now)
    .run();
  return json({ style: await getStyle(env, id) }, { status: 201 });
}

async function updateStyle(request: Request, env: Env, style: string): Promise<Response> {
  const current = await requireExistingStyle(env, style);
  const body = await readJsonObject(request);
  const nextStatus = body.status === undefined ? current.status : requiredText(body.status, 20, "状态");
  if (!['draft', 'published'].includes(nextStatus)) {
    throw new HttpError(400, "invalid_status", "状态只能是 draft 或 published。");
  }
  if (nextStatus === "published" && current.status !== "published") {
    const status = await styleStatusData(env, style);
    const cells = status.cells as Array<{ key: string; state: string }>;
    const thumbnail = status.thumbnail as { key: string; state: string };
    const missing = cells.filter((cell) => cell.state !== "healthy").map((cell) => cell.key);
    if (thumbnail.state !== "healthy") missing.push(thumbnail.key);
    if (missing.length) {
      throw new HttpError(409, "style_incomplete", "发布前需要完整的 16 张结果图、1 张缩略图及对应 D1 索引。", { missing });
    }
  }
  const now = new Date().toISOString();
  await env.TRYON_DB.prepare(
    `UPDATE tryon_styles SET
      label = ?, category = ?, description = ?, shopify_product_handle = ?,
      shopify_variant_id = ?, status = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      body.label === undefined ? current.label : requiredText(body.label, 120, "款式名称"),
      body.category === undefined ? current.category : optionalText(body.category, 120),
      body.description === undefined ? current.description : optionalText(body.description, 2_000),
      body.shopifyProductHandle === undefined ? current.shopify_product_handle : optionalText(body.shopifyProductHandle, 255),
      body.shopifyVariantId === undefined ? current.shopify_variant_id : optionalText(body.shopifyVariantId, 255),
      nextStatus,
      now,
      style,
    )
    .run();
  return json({ style: await getStyle(env, style) });
}

async function createUploadSession(request: Request, env: Env, actor: Actor): Promise<Response> {
  const body = await readJsonObject(request);
  const style = requireStyle(requiredText(body.styleId, 3, "款式编号"));
  await requireExistingStyle(env, style);
  const session = {
    id: crypto.randomUUID(),
    styleId: style,
    plannedCreate: boundedCount(body.plannedCreate),
    plannedOverwrite: boundedCount(body.plannedOverwrite),
    plannedSkip: boundedCount(body.plannedSkip),
    createdAt: new Date().toISOString(),
  };
  await env.TRYON_DB.prepare(
    `INSERT INTO tryon_upload_sessions (
      id, style_id, actor_email, status, planned_create, planned_overwrite,
      planned_skip, created_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  )
    .bind(
      session.id,
      style,
      actor.email,
      session.plannedCreate,
      session.plannedOverwrite,
      session.plannedSkip,
      session.createdAt,
    )
    .run();
  return json({ session }, { status: 201 });
}

async function finishUploadSession(request: Request, env: Env, actor: Actor, id: string): Promise<Response> {
  const body = await readJsonObject(request);
  const status = body.status === "failed" ? "failed" : "completed";
  const result = await env.TRYON_DB.prepare(
    `UPDATE tryon_upload_sessions SET status = ?, completed_create = ?,
      completed_overwrite = ?, failed_count = ?, completed_at = ?
      WHERE id = ? AND actor_email = ?`,
  )
    .bind(
      status,
      boundedCount(body.completedCreate),
      boundedCount(body.completedOverwrite),
      boundedCount(body.failedCount),
      new Date().toISOString(),
      id,
      actor.email,
    )
    .run();
  if (!result.meta.changes) throw new HttpError(404, "session_not_found", "上传会话不存在。");
  return json({ ok: true });
}

async function validateSession(env: Env, actor: Actor, style: string, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const session = await env.TRYON_DB.prepare(
    "SELECT id FROM tryon_upload_sessions WHERE id = ? AND style_id = ? AND actor_email = ? AND status = 'active'",
  )
    .bind(sessionId, style, actor.email)
    .first<{ id: string }>();
  if (!session) throw new HttpError(409, "invalid_upload_session", "上传会话无效或已经结束。");
  return session.id;
}

async function logUploadEvent(
  env: Env,
  values: {
    sessionId: string | null;
    actor: Actor;
    style: string;
    kind: UploadKind;
    tone: Tone | null;
    view: View | null;
    action: string;
    key: string;
    previousEtag: string | null;
    newEtag: string | null;
    size: number | null;
    dimensions: Dimensions | null;
    status: string;
    errorMessage?: string | null;
  },
): Promise<void> {
  await env.TRYON_DB.prepare(
    `INSERT INTO tryon_upload_events (
      id, session_id, actor_email, style_id, kind, tone, view, action, r2_key,
      previous_etag, new_etag, size, width, height, status, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      values.sessionId,
      values.actor.email,
      values.style,
      values.kind,
      values.tone,
      values.view,
      values.action,
      values.key,
      values.previousEtag,
      values.newEtag,
      values.size,
      values.dimensions?.width ?? null,
      values.dimensions?.height ?? null,
      values.status,
      values.errorMessage ?? null,
      new Date().toISOString(),
    )
    .run();
}

async function upsertAssetMetadata(
  env: Env,
  style: string,
  kind: UploadKind,
  key: string,
  tone: Tone | null,
  view: View | null,
  dimensions: Dimensions,
  etag: string,
): Promise<void> {
  const id = kind === "cover" ? `${style}-cover` : `${style}-${tone}-${view}`;
  const now = new Date().toISOString();
  await env.TRYON_DB.prepare(
    `INSERT INTO tryon_assets (
      id, style_id, kind, tone, view, r2_key, width, height,
      qa_status, visual_status, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pass', 'approved', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      style_id = excluded.style_id, kind = excluded.kind, tone = excluded.tone,
      view = excluded.view, r2_key = excluded.r2_key, width = excluded.width,
      height = excluded.height, qa_status = 'pass', visual_status = 'approved',
      version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(id, style, kind, tone, view, key, dimensions.width, dimensions.height, etag, now)
    .run();
  if (kind === "cover") {
    await env.TRYON_DB.prepare("UPDATE tryon_styles SET cover_r2_key = ?, updated_at = ? WHERE id = ?")
      .bind(key, now, style)
      .run();
  }
}

async function uploadImage(
  request: Request,
  env: Env,
  actor: Actor,
  style: string,
  kind: UploadKind,
  tone: Tone | null,
  view: View | null,
): Promise<Response> {
  await requireExistingStyle(env, style);
  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "image/webp") {
    throw new HttpError(415, "webp_required", "服务器只接收 WebP；PNG/JPEG 会先在浏览器中转换。");
  }
  const maxBytes = Number(env.MAX_UPLOAD_BYTES) || 12_582_912;
  const body = await readBodyBounded(request, maxBytes);
  const dimensions = parseWebPDimensions(body);
  const key = kind === "cover" ? iconKey(style) : resultKey(style, tone!, view!);
  const current = await env.tryon_assets.head(key);
  const overwrite = new URL(request.url).searchParams.get("overwrite") === "true";
  if (current && !overwrite) {
    throw new HttpError(409, "object_exists", "该位置已有图片；默认不会覆盖。", {
      key,
      etag: current.etag,
      size: current.size,
    });
  }
  if (current && overwrite) {
    const supplied = request.headers.get("If-Match");
    if (!supplied) throw new HttpError(428, "if_match_required", "覆盖前需要基于最新版本再次确认。");
    if (cleanEtag(supplied) !== cleanEtag(current.etag)) {
      throw new HttpError(412, "object_changed", "线上图片已被其他人更新，请刷新状态后再确认覆盖。");
    }
  }

  const sessionId = await validateSession(env, actor, style, request.headers.get("X-Upload-Session"));
  const action = current ? "overwrite" : "create";
  const onlyIf = current
    ? { etagMatches: current.etag }
    : new Headers({ "If-None-Match": "*" });
  const uploaded = await env.tryon_assets.put(key, body, {
    onlyIf,
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      style,
      kind,
      tone: tone || "",
      view: view || "",
      width: String(dimensions.width),
      height: String(dimensions.height),
      uploadedBy: actor.email,
    },
  });
  if (!uploaded) {
    throw new HttpError(412, "object_changed", "线上图片已变化，请刷新后重试。");
  }

  let metadataSynced = true;
  let metadataError: string | null = null;
  try {
    await upsertAssetMetadata(env, style, kind, key, tone, view, dimensions, uploaded.etag);
  } catch (error) {
    metadataSynced = false;
    metadataError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "metadata_sync_failed", key, error: metadataError }));
  }
  try {
    await logUploadEvent(env, {
      sessionId,
      actor,
      style,
      kind,
      tone,
      view,
      action,
      key,
      previousEtag: current?.etag || null,
      newEtag: uploaded.etag,
      size: uploaded.size,
      dimensions,
      status: metadataSynced ? "success" : "metadata_warning",
      errorMessage: metadataError,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "audit_log_failed", key, error: String(error) }));
  }
  return json(
    {
      ok: true,
      action,
      metadataSynced,
      warning: metadataSynced ? null : "R2 已上传，但 D1 索引失败；请点击“修复 D1 索引”。",
      object: serializeObject(env, uploaded),
      dimensions,
    },
    { status: metadataSynced ? (current ? 200 : 201) : 202 },
  );
}

async function reconcileStyle(env: Env, actor: Actor, style: string): Promise<Response> {
  requireStyle(style);
  if (!(await getStyle(env, style))) {
    const maxOrder = await env.TRYON_DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM tryon_styles").first<{ value: number }>();
    await env.TRYON_DB.prepare(
      `INSERT INTO tryon_styles (
        id, label, category, cover_r2_key, status, sort_order, updated_at
      ) VALUES (?, ?, 'Try-On', ?, 'draft', ?, ?)`,
    )
      .bind(style, `Style ${style}`, iconKey(style), (maxOrder?.value || 0) + 10, new Date().toISOString())
      .run();
  }
  const status = await styleStatusData(env, style);
  const cells = status.cells as Array<{
    tone: Tone;
    view: View;
    key: string;
    state: string;
    object: { etag: string; width: number | null; height: number | null } | null;
  }>;
  const thumbnail = status.thumbnail as {
    key: string;
    state: string;
    object: { etag: string; width: number | null; height: number | null } | null;
  };
  const repaired: string[] = [];
  for (const cell of cells) {
    if (!cell.object || cell.state === "healthy") continue;
    const dimensions = { width: cell.object.width || 0, height: cell.object.height || 0 };
    await upsertAssetMetadata(env, style, "result", cell.key, cell.tone, cell.view, dimensions, cell.object.etag);
    repaired.push(cell.key);
  }
  if (thumbnail.object && thumbnail.state !== "healthy") {
    const dimensions = { width: thumbnail.object.width || 0, height: thumbnail.object.height || 0 };
    await upsertAssetMetadata(env, style, "cover", thumbnail.key, null, null, dimensions, thumbnail.object.etag);
    repaired.push(thumbnail.key);
  }
  await logUploadEvent(env, {
    sessionId: null,
    actor,
    style,
    kind: "result",
    tone: null,
    view: null,
    action: "reconcile",
    key: `tryon/results/${style}-*`,
    previousEtag: null,
    newEtag: null,
    size: null,
    dimensions: null,
    status: "success",
    errorMessage: repaired.length ? `repaired:${repaired.length}` : null,
  });
  return json({ ok: true, repaired, status: await styleStatusData(env, style) });
}

async function routeApi(request: Request, env: Env, actor: Actor): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/session") {
    return json({ actor, tones: TONES, views: VIEWS, viewLabels: VIEW_LABELS });
  }
  if (request.method === "GET" && path === "/api/styles") return listStyles(env);
  const assetMatch = /^\/api\/assets\/(.+)$/.exec(path);
  if (["GET", "HEAD"].includes(request.method) && assetMatch?.[1]) {
    return serveAdminAsset(request, env, assetMatch[1]);
  }
  if (request.method === "POST" && path === "/api/styles") return createStyle(request, env);
  if (request.method === "POST" && path === "/api/upload-sessions") {
    return createUploadSession(request, env, actor);
  }
  const sessionMatch = /^\/api\/upload-sessions\/([0-9a-f-]+)$/.exec(path);
  if (request.method === "PATCH" && sessionMatch?.[1]) {
    return finishUploadSession(request, env, actor, sessionMatch[1]);
  }
  const statusMatch = /^\/api\/styles\/(\d{3})\/status$/.exec(path);
  if (request.method === "GET" && statusMatch?.[1]) {
    return json(await styleStatusData(env, statusMatch[1]));
  }
  const styleMatch = /^\/api\/styles\/(\d{3})$/.exec(path);
  if (request.method === "PATCH" && styleMatch?.[1]) {
    return updateStyle(request, env, styleMatch[1]);
  }
  const reconcileMatch = /^\/api\/styles\/(\d{3})\/reconcile$/.exec(path);
  if (request.method === "POST" && reconcileMatch?.[1]) {
    return reconcileStyle(env, actor, reconcileMatch[1]);
  }
  const iconMatch = /^\/api\/styles\/(\d{3})\/icon$/.exec(path);
  if (request.method === "PUT" && iconMatch?.[1]) {
    return uploadImage(request, env, actor, iconMatch[1], "cover", null, null);
  }
  const resultMatch = /^\/api\/styles\/(\d{3})\/results\/([^/]+)\/([^/]+)$/.exec(path);
  if (request.method === "PUT" && resultMatch?.[1] && resultMatch[2] && resultMatch[3]) {
    const style = requireStyle(resultMatch[1]);
    if (!isTone(resultMatch[2])) throw new HttpError(400, "invalid_tone", "肤色必须是 light、medium、tan 或 deep。");
    if (!isView(resultMatch[3])) throw new HttpError(400, "invalid_view", "视角必须是 01、02、03 或 04。");
    return uploadImage(request, env, actor, style, "result", resultMatch[2], resultMatch[3]);
  }
  throw new HttpError(404, "not_found", "接口不存在。");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "ai-commerce-asset-ops" });
    }
    try {
      const actor = await authenticate(request, env);
      enforceSameOrigin(request);
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env, actor);
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "method_not_allowed", "不支持该请求方式。");
      }
      return withStaticSecurity(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          { error: error.code, message: error.message, details: error.details ?? null },
          { status: error.status },
        );
      }
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: "unhandled_error", requestId, error: String(error) }));
      return json(
        { error: "internal_error", message: "服务暂时出现问题，请稍后重试。", requestId },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
