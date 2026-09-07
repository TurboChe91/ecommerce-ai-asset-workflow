import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { parseWebPDimensions, TONES, VIEWS } from "../src/index";

function webp(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  view.setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Authenticated-User-Email", "qa-operator@example.com");
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD"].includes(init.method || "GET") && !headers.has("Origin")) {
    headers.set("Origin", "http://localhost");
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(request(path, init), env);
}

async function createStyle(id = "001"): Promise<Response> {
  return call("/api/styles", {
    method: "POST",
    body: JSON.stringify({ id, label: `Style ${id}`, category: "Try-On" }),
  });
}

async function upload(path: string, body = webp(), headers: HeadersInit = {}): Promise<Response> {
  return call(path, {
    method: "PUT",
    headers: { "Content-Type": "image/webp", ...headers },
    body: body.buffer as ArrayBuffer,
  });
}

beforeEach(async () => {
  await env.TRYON_DB.batch([
    env.TRYON_DB.prepare("DELETE FROM tryon_upload_events"),
    env.TRYON_DB.prepare("DELETE FROM tryon_upload_sessions"),
    env.TRYON_DB.prepare("DELETE FROM tryon_assets"),
    env.TRYON_DB.prepare("DELETE FROM tryon_styles"),
  ]);
  const resultObjects = await env.tryon_assets.list({ prefix: "tryon/results/" });
  const iconObjects = await env.tryon_assets.list({ prefix: "tryon/icons/" });
  await Promise.all([...resultObjects.objects, ...iconObjects.objects].map((object) => env.tryon_assets.delete(object.key)));
});

describe("image contract", () => {
  it("parses VP8X dimensions", () => {
    expect(parseWebPDimensions(webp(1691, 930).buffer as ArrayBuffer)).toEqual({ width: 1691, height: 930 });
  });

  it("rejects a non-WebP body", async () => {
    await createStyle();
    const response = await upload("/api/styles/001/results/light/01", new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: "invalid_webp" });
  });
});

describe("styles and inventory", () => {
  it("creates new styles as drafts", async () => {
    const response = await createStyle("021");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ style: { id: "021", status: "draft" } });
  });

  it("stores and later updates Shopify variant metadata without changing status", async () => {
    const createResponse = await call("/api/styles", {
      method: "POST",
      body: JSON.stringify({
        id: "021",
        label: "Style 021",
        category: "Try-On",
        shopifyProductHandle: "style-021",
        shopifyVariantId: "100",
      }),
    });
    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      style: {
        shopify_product_handle: "style-021",
        shopify_variant_id: "100",
        status: "draft",
      },
    });

    const updateResponse = await call("/api/styles/021", {
      method: "PATCH",
      body: JSON.stringify({
        shopifyProductHandle: "style-021-final",
        shopifyVariantId: "200",
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      style: {
        shopify_product_handle: "style-021-final",
        shopify_variant_id: "200",
        status: "draft",
      },
    });
    const stored = await env.TRYON_DB.prepare(
      "SELECT shopify_product_handle, shopify_variant_id, status FROM tryon_styles WHERE id = '021'",
    ).first<{ shopify_product_handle: string; shopify_variant_id: string; status: string }>();
    expect(stored).toEqual({
      shopify_product_handle: "style-021-final",
      shopify_variant_id: "200",
      status: "draft",
    });
  });

  it("discovers a canonical R2-only style and can reconcile it", async () => {
    await env.tryon_assets.put("tryon/results/099-light-01.webp", webp(), {
      customMetadata: { width: "2", height: "3" },
    });
    const list = await (await call("/api/styles")).json<{ styles: Array<{ id: string; hasMetadata: boolean }> }>();
    expect(list.styles).toContainEqual(expect.objectContaining({ id: "099", hasMetadata: false }));

    const response = await call("/api/styles/099/reconcile", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    const style = await env.TRYON_DB.prepare("SELECT status FROM tryon_styles WHERE id = '099'").first<{ status: string }>();
    expect(style?.status).toBe("draft");
    const asset = await env.TRYON_DB.prepare("SELECT qa_status FROM tryon_assets WHERE id = '099-light-01'").first<{ qa_status: string }>();
    expect(asset?.qa_status).toBe("pass");
  });
});

describe("safe differential uploads", () => {
  it("creates, indexes, audits, and reports a missing result", async () => {
    await createStyle();
    const sessionResponse = await call("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ styleId: "001", plannedCreate: 1, plannedOverwrite: 0, plannedSkip: 0 }),
    });
    const { session } = await sessionResponse.json<{ session: { id: string } }>();
    const response = await upload("/api/styles/001/results/light/01", webp(100, 80), {
      "X-Upload-Session": session.id,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, action: "create", metadataSynced: true });

    const object = await env.tryon_assets.head("tryon/results/001-light-01.webp");
    expect(object?.customMetadata).toMatchObject({ width: "100", height: "80", uploadedBy: "qa-operator@example.com" });
    const asset = await env.TRYON_DB.prepare("SELECT * FROM tryon_assets WHERE id = '001-light-01'").first<{
      width: number;
      height: number;
      qa_status: string;
      visual_status: string;
    }>();
    expect(asset).toMatchObject({ width: 100, height: 80, qa_status: "pass", visual_status: "approved" });
    const event = await env.TRYON_DB.prepare("SELECT action, actor_email FROM tryon_upload_events").first<{
      action: string;
      actor_email: string;
    }>();
    expect(event).toEqual({ action: "create", actor_email: "qa-operator@example.com" });

    const status = await (await call("/api/styles/001/status")).json<{ resultCount: number; missingCount: number }>();
    expect(status).toMatchObject({ resultCount: 1, missingCount: 15 });
    const preview = await call("/api/assets/tryon/results/001-light-01.webp");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toContain("private");
    expect((await preview.arrayBuffer()).byteLength).toBe(webp(100, 80).byteLength);
  });

  it("skips an existing object unless overwrite and a current ETag are explicit", async () => {
    await createStyle();
    expect((await upload("/api/styles/001/results/light/01", webp(10, 10))).status).toBe(201);
    expect((await upload("/api/styles/001/results/light/01", webp(20, 20))).status).toBe(409);
    expect((await upload("/api/styles/001/results/light/01?overwrite=true", webp(20, 20))).status).toBe(428);
    expect((await upload("/api/styles/001/results/light/01?overwrite=true", webp(20, 20), { "If-Match": '"stale"' })).status).toBe(412);

    const current = await env.tryon_assets.head("tryon/results/001-light-01.webp");
    const response = await upload("/api/styles/001/results/light/01?overwrite=true", webp(20, 20), {
      "If-Match": `"${current?.etag}"`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "overwrite", dimensions: { width: 20, height: 20 } });
  });

  it("stores the thumbnail separately and requires all 17 objects before publishing", async () => {
    await createStyle();
    expect((await upload("/api/styles/001/icon", webp(240, 160))).status).toBe(201);
    expect(await env.tryon_assets.head("tryon/icons/001-light-icon.webp")).not.toBeNull();
    expect((await call("/api/styles/001", { method: "PATCH", body: JSON.stringify({ status: "published" }) })).status).toBe(409);

    await Promise.all(
      TONES.flatMap((tone) => VIEWS.map((view) => env.tryon_assets.put(`tryon/results/001-${tone}-${view}.webp`, webp()))),
    );
    expect((await call("/api/styles/001", { method: "PATCH", body: JSON.stringify({ status: "published" }) })).status).toBe(409);
    expect((await call("/api/styles/001/reconcile", { method: "POST", body: "{}" })).status).toBe(200);
    const response = await call("/api/styles/001", { method: "PATCH", body: JSON.stringify({ status: "published" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ style: { status: "published" } });
  });
});

describe("request security", () => {
  it("rejects cross-origin mutations", async () => {
    const response = await call("/api/styles", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ id: "001", label: "Style 001" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "cross_origin_denied" });
  });

  it("validates style, tone, and view segments", async () => {
    await createStyle();
    expect((await upload("/api/styles/001/results/fair/01")).status).toBe(400);
    expect((await upload("/api/styles/001/results/light/05")).status).toBe(400);
  });
});
