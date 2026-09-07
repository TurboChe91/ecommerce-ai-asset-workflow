-- Safe bootstrap for local/test databases. These statements are no-ops on the
-- existing production database used by the public try-on API.
CREATE TABLE IF NOT EXISTS tryon_styles (
  id TEXT PRIMARY KEY,
  shopify_product_handle TEXT,
  shopify_variant_id TEXT,
  label TEXT NOT NULL,
  category TEXT,
  description TEXT,
  price_text TEXT,
  cover_r2_key TEXT,
  plan_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  sort_order INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tryon_assets (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tone TEXT,
  view TEXT,
  r2_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  qa_status TEXT NOT NULL DEFAULT 'review',
  visual_status TEXT NOT NULL DEFAULT 'review',
  version TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (style_id) REFERENCES tryon_styles(id)
);

CREATE INDEX IF NOT EXISTS idx_tryon_styles_status
  ON tryon_styles(status, sort_order);
CREATE INDEX IF NOT EXISTS idx_tryon_assets_lookup
  ON tryon_assets(style_id, kind, tone, view, qa_status, visual_status);
