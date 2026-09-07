const TONES = ["light", "medium", "tan", "deep"];
const VIEWS = ["01", "02", "03", "04"];
const VIEW_LABELS = {
  "01": "Open hands",
  "02": "Right hand",
  "03": "Thumb visible",
  "04": "Left hand",
};
const TONE_CODES = { light: "A", medium: "B", tan: "C", deep: "D" };
const MAX_CLIENT_BYTES = 12 * 1024 * 1024;

const state = {
  actor: null,
  styles: [],
  selectedId: null,
  status: null,
  staged: new Map(),
  unmatched: [],
  busy: false,
  search: "",
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  operator: $("#operator-email"),
  styleList: $("#style-list"),
  styleTotal: $("#style-total"),
  search: $("#style-search"),
  empty: $("#empty-state"),
  workspace: $("#style-workspace"),
  styleId: $("#selected-style-id"),
  styleLabel: $("#selected-style-label"),
  styleStatus: $("#selected-style-status"),
  styleSubtitle: $("#selected-style-subtitle"),
  resultCount: $("#result-count"),
  progressRing: $("#progress-ring"),
  completionTitle: $("#completion-title"),
  missingSummary: $("#missing-summary"),
  thumbnailSummary: $("#thumbnail-summary"),
  thumbnailKey: $("#thumbnail-key"),
  thumbnailPreview: $("#thumbnail-preview"),
  thumbnailAction: $("#thumbnail-action"),
  matrix: $("#coverage-matrix"),
  unmatchedPanel: $("#unmatched-panel"),
  unmatchedCount: $("#unmatched-count"),
  unmatchedList: $("#unmatched-list"),
  batchBar: $("#batch-bar"),
  batchCount: $("#batch-count"),
  batchDescription: $("#batch-description"),
  batchProgress: $("#batch-progress"),
  batchProgressFill: $("#batch-progress-fill"),
  startUpload: $("#start-upload-button"),
  clearStage: $("#clear-stage-button"),
  overwriteDialog: $("#overwrite-dialog"),
  overwriteList: $("#overwrite-list"),
  confirmOverwrite: $("#confirm-overwrite-button"),
  newStyleDialog: $("#new-style-dialog"),
  newStyleForm: $("#new-style-form"),
  editStyleButton: $("#edit-style-button"),
  editStyleDialog: $("#edit-style-dialog"),
  editStyleForm: $("#edit-style-form"),
  editStyleSubmit: $("#edit-style-submit"),
  toastStack: $("#toast-stack"),
};

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percentageClass(value) {
  const rounded = Math.max(0, Math.min(100, Math.round(value / 5) * 5));
  return `pct-${rounded}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message, type = "success", timeout = 4200) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  elements.toastStack.append(node);
  window.setTimeout(() => node.remove(), timeout);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.message || `请求失败 (${response.status})`, response.status, payload.error, payload.details);
  }
  return payload;
}

function versionedUrl(object) {
  if (!object?.url) return "";
  const separator = object.url.includes("?") ? "&" : "?";
  return `${object.url}${separator}v=${encodeURIComponent(object.etag || object.uploadedAt || Date.now())}`;
}

function cellKey(tone, view) {
  return `result:${tone}:${view}`;
}

function getCell(tone, view) {
  return state.status?.cells?.find((cell) => cell.tone === tone && cell.view === view) || null;
}

function getExistingForStage(key) {
  if (key === "cover") return state.status?.thumbnail?.object || null;
  const [, tone, view] = key.split(":");
  return getCell(tone, view)?.object || null;
}

function describeSlot(stage) {
  if (stage.kind === "cover") return "款式缩略图";
  return `${TONE_CODES[stage.tone]}${Number(stage.view)} · ${stage.tone} / ${stage.view}`;
}

async function loadSession() {
  const payload = await api("/api/session");
  state.actor = payload.actor;
  elements.operator.textContent = payload.actor.email;
}

async function loadStyles() {
  const payload = await api("/api/styles");
  state.styles = payload.styles;
  renderStyles();
}

function renderStyles() {
  const query = state.search.trim().toLowerCase();
  const styles = state.styles.filter((style) =>
    !query || style.id.includes(query) || style.label.toLowerCase().includes(query),
  );
  elements.styleTotal.textContent = `${styles.length}`;
  if (!styles.length) {
    elements.styleList.innerHTML = '<div class="sidebar-empty">没有匹配的款式</div>';
    return;
  }
  elements.styleList.innerHTML = styles.map((style) => {
    const active = style.id === state.selectedId ? " is-active" : "";
    const percent = (style.resultCount / 16) * 100;
    const thumb = style.hasThumbnail
      ? `<img src="/api/assets/tryon/icons/${escapeHtml(style.id)}-light-icon.webp?v=${encodeURIComponent(style.updatedAt || "1")}" alt="" loading="lazy" />`
      : escapeHtml(style.id);
    return `
      <button class="style-item${active}" type="button" data-style-id="${escapeHtml(style.id)}">
        <span class="style-thumb">${thumb}</span>
        <span class="style-copy">
          <strong>${escapeHtml(style.label)}</strong>
          <span>${escapeHtml(style.id)} · ${style.hasThumbnail ? "有缩略图" : "无缩略图"}</span>
        </span>
        <span class="mini-progress">
          <span>${style.resultCount}/16</span>
          <span class="mini-track"><i class="${percentageClass(percent)}"></i></span>
        </span>
      </button>`;
  }).join("");
}

async function selectStyle(id, options = {}) {
  if (id === state.selectedId && !options.force) return;
  if (state.staged.size && id !== state.selectedId) {
    const leave = window.confirm("切换款式会清空当前尚未上传的图片，是否继续？");
    if (!leave) return;
    clearStaged(false);
  }
  state.selectedId = id;
  state.status = null;
  elements.editStyleButton.disabled = true;
  renderStyles();
  elements.empty.classList.add("is-hidden");
  elements.workspace.classList.remove("is-hidden");
  elements.styleId.textContent = id;
  elements.styleLabel.textContent = "读取中…";
  elements.styleSubtitle.textContent = "正在同时检查 R2 对象与 D1 索引…";
  elements.matrix.innerHTML = '<div class="sidebar-skeleton"></div>';
  try {
    state.status = await api(`/api/styles/${id}/status`);
    renderStatus();
  } catch (error) {
    toast(error.message, "error");
  }
}

function statusLabel(status) {
  if (status === "published") return "已发布";
  if (status === "draft") return "草稿";
  return "未建索引";
}

function stateLabel(cell) {
  if (cell.state === "healthy") return "线上已有";
  if (cell.state === "object_only") return "R2 已有 · D1 待修复";
  if (cell.state === "metadata_only") return "D1 残留 · R2 缺失";
  return "缺失";
}

function renderStatus() {
  const data = state.status;
  if (!data) return;
  const style = data.style || { id: state.selectedId, label: `Style ${state.selectedId}`, status: "unindexed" };
  elements.styleId.textContent = style.id;
  elements.styleLabel.textContent = style.label;
  elements.styleStatus.textContent = statusLabel(style.status);
  elements.styleStatus.className = `status-badge ${style.status}`;
  elements.styleSubtitle.textContent = data.existsInD1
    ? `最后更新 ${new Date(style.updated_at).toLocaleString("zh-CN")}`
    : "R2 中发现图片，但 D1 尚无款式记录；先点击“修复 D1 索引”。";
  elements.resultCount.textContent = `${data.resultCount}`;
  elements.progressRing.className = `progress-ring ${data.resultCount === 16 ? "complete" : data.resultCount ? "partial" : ""}`;
  elements.completionTitle.textContent = data.resultCount === 16 ? "16 张已完整" : data.resultCount ? "仍需补齐" : "尚未上传";
  elements.missingSummary.textContent = data.missingCount ? `缺少 ${data.missingCount} 个位置` : "所有肤色和视角均已就绪";
  elements.thumbnailSummary.textContent = data.thumbnail.object ? "已单独上传" : "缺失";
  elements.thumbnailKey.textContent = data.thumbnail.key;
  const publishButton = $("#toggle-publish-button");
  publishButton.textContent = style.status === "published" ? "转为草稿" : "发布款式";
  publishButton.disabled = !data.existsInD1;
  elements.editStyleButton.disabled = !data.existsInD1;
  elements.editStyleButton.title = data.existsInD1 ? "补充或修改 Shopify Variant ID 等款式信息" : "请先修复 D1 索引";
  renderThumbnail();
  renderMatrix();
  renderBatchBar();
}

function renderThumbnail() {
  const thumbnail = state.status?.thumbnail;
  if (!thumbnail) return;
  const staged = state.staged.get("cover");
  const source = staged?.url || versionedUrl(thumbnail.object);
  elements.thumbnailPreview.innerHTML = source
    ? `<img src="${escapeHtml(source)}" alt="款式缩略图预览" /><span class="preview-chip">${staged ? "待提交" : "线上版本"}</span>`
    : '<div class="preview-placeholder">暂无缩略图</div>';
  if (!staged) {
    elements.thumbnailAction.innerHTML = `<p>${thumbnail.object ? `${escapeHtml(formatBytes(thumbnail.object.size))} · ${thumbnail.object.width || "?"}×${thumbnail.object.height || "?"}` : "请上传独立缩略图"}</p>`;
    return;
  }
  const hasExisting = Boolean(thumbnail.object);
  elements.thumbnailAction.innerHTML = `
    <p>${escapeHtml(staged.fileName)}<br>${staged.width}×${staged.height} · ${formatBytes(staged.blob.size)}</p>
    ${hasExisting ? `<button class="button button-small ${staged.overwrite ? "button-danger" : "button-secondary"}" type="button" data-action="toggle-cover-overwrite">${staged.overwrite ? "将直接覆盖" : "允许覆盖"}</button>` : '<span class="status-badge published">待新增</span>'}
    <button class="button button-small button-quiet" type="button" data-action="remove-cover">移除待提交</button>`;
}

function renderMatrix() {
  if (!state.status) return;
  const header = [
    '<div class="matrix-corner"></div>',
    ...VIEWS.map((view) => `<div class="matrix-column"><div><strong>${view}</strong><span>${escapeHtml(VIEW_LABELS[view])}</span></div></div>`),
  ];
  const rows = TONES.flatMap((tone) => {
    const rowHeader = `<div class="matrix-row"><strong>${escapeHtml(tone)}</strong><span>${TONE_CODES[tone]} · 肤色</span></div>`;
    const cells = VIEWS.map((view) => renderCell(tone, view));
    return [rowHeader, ...cells];
  });
  elements.matrix.innerHTML = [...header, ...rows].join("");
}

function renderCell(tone, view) {
  const cell = getCell(tone, view);
  const key = cellKey(tone, view);
  const staged = state.staged.get(key);
  const image = staged?.url || versionedUrl(cell?.object);
  const classes = [`matrix-cell`, `state-${cell?.state || "missing"}`];
  if (staged) classes.push("has-stage");
  let primary = stateLabel(cell || { state: "missing" });
  if (staged) {
    primary = cell?.object ? (staged.overwrite ? "待覆盖" : "已有 · 默认跳过") : "待新增";
    if (staged.status === "uploading") primary = "正在上传";
    if (staged.status === "failed") primary = "上传失败";
  }
  const detail = staged
    ? `${staged.width}×${staged.height} · ${formatBytes(staged.blob.size)}`
    : cell?.object
      ? `${cell.object.width || "?"}×${cell.object.height || "?"} · ${formatBytes(cell.object.size)}`
      : `需要 ${tone}-${view}.webp`;
  const controls = staged ? `
    ${cell?.object ? `<button class="button button-small ${staged.overwrite ? "button-danger" : "button-secondary"}" type="button" data-action="toggle-overwrite" data-tone="${tone}" data-view="${view}">${staged.overwrite ? "将覆盖" : "允许覆盖"}</button>` : ""}
    <button class="button button-small button-quiet" type="button" data-action="remove-stage" data-tone="${tone}" data-view="${view}">移除</button>` : "";
  const badge = staged ? `<span class="stage-badge ${staged.status || ""}">${staged.status === "failed" ? "失败" : staged.status === "uploading" ? `${staged.progress || 0}%` : "待提交"}</span>` : "";
  const progress = staged?.status === "uploading"
    ? `<div class="cell-progress"><span class="${percentageClass(staged.progress || 0)}"></span></div>`
    : "";
  return `
    <div class="${classes.join(" ")}" data-cell-tone="${tone}" data-cell-view="${view}">
      <label class="cell-drop" title="点击或拖入 ${tone} / ${view}">
        <input type="file" accept="image/png,image/jpeg,image/webp" data-cell-input data-tone="${tone}" data-view="${view}" />
      </label>
      ${badge}
      <div class="cell-image">${image ? `<img src="${escapeHtml(image)}" alt="${tone} ${view} 预览" />` : `<div class="cell-placeholder">${TONE_CODES[tone]}${Number(view)}</div>`}</div>
      <div class="cell-info">
        <div class="cell-state"><strong>${escapeHtml(primary)}</strong><span>${escapeHtml(staged?.error || detail)}</span></div>
        <div class="cell-controls">${controls}</div>
      </div>
      ${progress}
    </div>`;
}

function renderUnmatched() {
  elements.unmatchedPanel.classList.toggle("is-hidden", state.unmatched.length === 0);
  elements.unmatchedCount.textContent = `${state.unmatched.length}`;
  elements.unmatchedList.innerHTML = state.unmatched.map((entry, index) => `
    <div class="unmatched-row" data-unmatched-index="${index}">
      <span class="unmatched-name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)} · ${escapeHtml(entry.reason)}</span>
      <select data-manual-tone aria-label="选择肤色">
        ${TONES.map((tone) => `<option value="${tone}">${TONE_CODES[tone]} · ${tone}</option>`).join("")}
      </select>
      <select data-manual-view aria-label="选择视角">
        ${VIEWS.map((view) => `<option value="${view}">${view} · ${escapeHtml(VIEW_LABELS[view])}</option>`).join("")}
      </select>
      <span>
        <button class="button button-small button-secondary" type="button" data-action="assign-unmatched">指定</button>
        <button class="button button-small button-quiet" type="button" data-action="drop-unmatched">忽略</button>
      </span>
    </div>`).join("");
}

function renderBatchBar() {
  const stages = [...state.staged.values()];
  elements.batchBar.classList.toggle("is-hidden", stages.length === 0);
  if (!stages.length) return;
  const create = stages.filter((stage) => !getExistingForStage(stage.key)).length;
  const overwrite = stages.filter((stage) => getExistingForStage(stage.key) && stage.overwrite).length;
  const skip = stages.length - create - overwrite;
  elements.batchCount.textContent = `${stages.length} 张已放入`;
  elements.batchDescription.textContent = `新增 ${create} · 覆盖 ${overwrite} · 跳过 ${skip}`;
  elements.startUpload.textContent = state.busy ? "上传进行中…" : `开始差异上传 (${create + overwrite})`;
  elements.startUpload.disabled = state.busy || create + overwrite === 0;
  elements.clearStage.disabled = state.busy;
}

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new Error("浏览器无法读取这张图片，请确认文件没有损坏。");
  }
}

function canvasToWebP(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器 WebP 转码失败。")), "image/webp", quality);
  });
}

async function prepareImage(file, options = {}) {
  if (!file || !file.size) throw new Error("图片文件为空。");
  if (file.size > MAX_CLIENT_BYTES) throw new Error("原图片超过 12 MB，请先压缩后重试。");
  const accepted = ["image/png", "image/jpeg", "image/webp"];
  const inferred = file.name.toLowerCase().endsWith(".png") ? "image/png"
    : /\.jpe?g$/i.test(file.name) ? "image/jpeg"
      : file.name.toLowerCase().endsWith(".webp") ? "image/webp" : file.type;
  if (!accepted.includes(file.type || inferred)) throw new Error("只支持 PNG、JPEG 或 WebP。");

  const bitmap = await decodeImage(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const maxDimension = options.maxDimension || 0;
  const scale = maxDimension && Math.max(originalWidth, originalHeight) > maxDimension
    ? maxDimension / Math.max(originalWidth, originalHeight)
    : 1;
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  let blob;
  if (file.type === "image/webp" && scale === 1) {
    blob = file.slice(0, file.size, "image/webp");
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("浏览器无法创建图片画布。");
    context.drawImage(bitmap, 0, 0, width, height);
    blob = await canvasToWebP(canvas, options.quality || 0.96);
  }
  bitmap.close();
  if (blob.size > MAX_CLIENT_BYTES) throw new Error("转码后的 WebP 仍超过 12 MB。");
  return { blob, width, height };
}

function parseFilename(fileName) {
  const base = fileName.replace(/\.(png|jpe?g|webp)$/i, "").trim().toLowerCase().replace(/[ _]+/g, "-");
  let match = /^(?:(\d{3})-)?(light|medium|tan|deep)-?0?([1-4])(?:-final)?$/.exec(base);
  if (match) {
    return { style: match[1] || null, tone: match[2], view: `0${match[3]}` };
  }
  match = /^(?:(\d{3})-)?([a-d])-?([1-4])(?:-final)?$/.exec(base);
  if (match) {
    return { style: match[1] || null, tone: TONES["abcd".indexOf(match[2])], view: `0${match[3]}` };
  }
  return null;
}

async function stageFile(file, tone, view, kind = "result", generatedName = null) {
  const key = kind === "cover" ? "cover" : cellKey(tone, view);
  const prepared = await prepareImage(file, kind === "cover" ? {} : undefined);
  const previous = state.staged.get(key);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  const stage = {
    key,
    kind,
    tone: kind === "cover" ? null : tone,
    view: kind === "cover" ? null : view,
    blob: prepared.blob,
    url: URL.createObjectURL(prepared.blob),
    fileName: generatedName || file.name,
    width: prepared.width,
    height: prepared.height,
    overwrite: false,
    status: "ready",
    progress: 0,
    error: null,
  };
  state.staged.set(key, stage);
  renderStatus();
}

async function handleBatchFiles(fileList) {
  if (!state.selectedId) return toast("请先选择款式。", "warning");
  const files = [...fileList];
  const claimed = new Set(state.staged.keys());
  let accepted = 0;
  for (const file of files) {
    const parsed = parseFilename(file.name);
    if (!parsed) {
      state.unmatched.push({ file, reason: "文件名无法识别" });
      continue;
    }
    if (parsed.style && parsed.style !== state.selectedId) {
      state.unmatched.push({ file, reason: `文件属于款式 ${parsed.style}` });
      continue;
    }
    const key = cellKey(parsed.tone, parsed.view);
    if (claimed.has(key)) {
      state.unmatched.push({ file, reason: `${TONE_CODES[parsed.tone]}${Number(parsed.view)} 已有待处理图片` });
      continue;
    }
    claimed.add(key);
    try {
      await stageFile(file, parsed.tone, parsed.view);
      accepted += 1;
    } catch (error) {
      state.unmatched.push({ file, reason: error.message });
    }
  }
  renderUnmatched();
  if (accepted) toast(`已识别并放入 ${accepted} 张图片。`);
  if (state.unmatched.length) toast(`${state.unmatched.length} 张需要手动指定或检查。`, "warning");
}

function removeStage(key) {
  const stage = state.staged.get(key);
  if (stage?.url) URL.revokeObjectURL(stage.url);
  state.staged.delete(key);
  renderStatus();
}

function clearStaged(showToast = true) {
  for (const stage of state.staged.values()) if (stage.url) URL.revokeObjectURL(stage.url);
  state.staged.clear();
  state.unmatched = [];
  renderUnmatched();
  if (state.status) renderStatus();
  if (showToast) toast("已清空尚未提交的图片。", "warning");
}

async function generateThumbnail() {
  const stagedLight = state.staged.get(cellKey("light", "01"));
  const currentLight = getCell("light", "01")?.object;
  if (!stagedLight && !currentLight) return toast("Light / 01 目前缺失，无法生成缩略图。", "warning");
  try {
    let sourceBlob = stagedLight?.blob;
    if (!sourceBlob) {
      const response = await fetch(versionedUrl(currentLight), { mode: "cors" });
      if (!response.ok) throw new Error("读取线上 Light / 01 失败。");
      sourceBlob = await response.blob();
    }
    const sourceFile = new File([sourceBlob], `${state.selectedId}-light-01.webp`, { type: "image/webp" });
    const prepared = await prepareImage(sourceFile, { maxDimension: 480, quality: 0.9 });
    const generated = new File([prepared.blob], `${state.selectedId}-light-icon.webp`, { type: "image/webp" });
    await stageFile(generated, null, null, "cover", `${state.selectedId}-light-icon.webp（由 Light/01 生成）`);
    toast("已在本机生成缩略图，请预览后再提交。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function confirmOverwrites(stages) {
  elements.overwriteList.innerHTML = stages.map((stage) => `
    <div class="overwrite-row"><span>${escapeHtml(describeSlot(stage))}</span><span>直接替换，无归档</span></div>`).join("");
  elements.confirmOverwrite.textContent = `确认覆盖 ${stages.length} 张`;
  return new Promise((resolve) => {
    const onClose = () => {
      elements.overwriteDialog.removeEventListener("close", onClose);
      resolve(elements.overwriteDialog.returnValue === "confirm");
    };
    elements.overwriteDialog.addEventListener("close", onClose);
    elements.overwriteDialog.showModal();
  });
}

function uploadWithProgress(stage, sessionId) {
  return new Promise((resolve, reject) => {
    const existing = getExistingForStage(stage.key);
    const path = stage.kind === "cover"
      ? `/api/styles/${state.selectedId}/icon`
      : `/api/styles/${state.selectedId}/results/${stage.tone}/${stage.view}`;
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${path}${existing ? "?overwrite=true" : ""}`);
    xhr.setRequestHeader("Content-Type", "image/webp");
    xhr.setRequestHeader("X-Upload-Session", sessionId);
    if (existing) xhr.setRequestHeader("If-Match", `"${existing.etag}"`);
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      stage.progress = Math.round((event.loaded / event.total) * 100);
      renderStatus();
      updateOverallProgress();
    });
    xhr.addEventListener("load", () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || "{}"); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(payload);
      reject(new ApiError(payload.message || `上传失败 (${xhr.status})`, xhr.status, payload.error, payload.details));
    });
    xhr.addEventListener("error", () => reject(new Error("网络连接中断。")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消。")));
    xhr.send(stage.blob);
  });
}

function updateOverallProgress() {
  const uploading = [...state.staged.values()].filter((stage) => ["uploading", "done", "failed"].includes(stage.status));
  if (!uploading.length) return;
  const percent = uploading.reduce((sum, stage) => sum + (stage.status === "done" ? 100 : stage.progress || 0), 0) / uploading.length;
  elements.batchProgressFill.className = percentageClass(percent);
}

async function startUpload() {
  if (state.busy || !state.status) return;
  const all = [...state.staged.values()];
  const creates = all.filter((stage) => !getExistingForStage(stage.key));
  const overwrites = all.filter((stage) => getExistingForStage(stage.key) && stage.overwrite);
  const skipped = all.filter((stage) => getExistingForStage(stage.key) && !stage.overwrite);
  const queue = [...creates, ...overwrites];
  if (!queue.length) return toast("放入的图片都对应已有位置；请逐格选择“允许覆盖”。", "warning");
  if (overwrites.length && !(await confirmOverwrites(overwrites))) return;

  state.busy = true;
  elements.batchProgress.classList.remove("is-hidden");
  for (const stage of queue) {
    stage.status = "uploading";
    stage.progress = 0;
    stage.error = null;
  }
  renderStatus();
  let sessionId = null;
  const counters = { create: 0, overwrite: 0, failed: 0 };
  try {
    const sessionPayload = await api("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({
        styleId: state.selectedId,
        plannedCreate: creates.length,
        plannedOverwrite: overwrites.length,
        plannedSkip: skipped.length,
      }),
    });
    sessionId = sessionPayload.session.id;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const stage = queue[cursor++];
        try {
          const result = await uploadWithProgress(stage, sessionId);
          stage.status = "done";
          stage.progress = 100;
          counters[result.action === "overwrite" ? "overwrite" : "create"] += 1;
          if (!result.metadataSynced) toast(result.warning, "warning", 7000);
        } catch (error) {
          stage.status = "failed";
          stage.error = error.message;
          counters.failed += 1;
        }
        renderStatus();
      }
    };
    await Promise.all([worker(), worker()]);
  } catch (error) {
    toast(error.message, "error", 7000);
    counters.failed += queue.filter((stage) => stage.status === "uploading").length;
    for (const stage of queue) {
      if (stage.status === "uploading") {
        stage.status = "failed";
        stage.error = "上传会话未能开始";
      }
    }
  } finally {
    if (sessionId) {
      await api(`/api/upload-sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: counters.failed ? "failed" : "completed",
          completedCreate: counters.create,
          completedOverwrite: counters.overwrite,
          failedCount: counters.failed,
        }),
      }).catch(() => {});
    }
    for (const [key, stage] of state.staged) {
      if (stage.status === "done") {
        URL.revokeObjectURL(stage.url);
        state.staged.delete(key);
      } else if (stage.status === "failed") {
        stage.status = "ready";
        stage.progress = 0;
      }
    }
    state.busy = false;
    elements.batchProgress.classList.add("is-hidden");
    elements.batchProgressFill.className = "pct-0";
    await Promise.all([loadStyles(), selectStyle(state.selectedId, { force: true })]);
    renderBatchBar();
    if (counters.failed) toast(`完成 ${counters.create + counters.overwrite} 张，失败 ${counters.failed} 张，可检查后重试。`, "warning", 7000);
    else toast(`上传完成：新增 ${counters.create} 张，覆盖 ${counters.overwrite} 张。`, "success", 6000);
  }
}

async function createStyle(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.newStyleDialog.close("cancel");
    return;
  }
  const form = new FormData(elements.newStyleForm);
  const body = Object.fromEntries(form.entries());
  try {
    const payload = await api("/api/styles", { method: "POST", body: JSON.stringify(body) });
    elements.newStyleDialog.close("created");
    elements.newStyleForm.reset();
    elements.newStyleForm.elements.category.value = "Try-On";
    await loadStyles();
    await selectStyle(payload.style.id, { force: true });
    toast(`款式 ${payload.style.id} 已以草稿创建。`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function openEditStyle() {
  const style = state.status?.style;
  if (!style || !state.status?.existsInD1) {
    toast("该款式还没有 D1 记录，请先修复 D1 索引。", "warning");
    return;
  }
  $("#edit-style-id").value = style.id;
  $("#edit-style-label").value = style.label || "";
  $("#edit-style-category").value = style.category || "";
  $("#edit-style-product-handle").value = style.shopify_product_handle || "";
  $("#edit-style-variant-id").value = style.shopify_variant_id || "";
  $("#edit-style-description").value = style.description || "";
  elements.editStyleDialog.showModal();
}

async function updateStyleMetadata(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.editStyleDialog.close("cancel");
    return;
  }
  const style = state.status?.style;
  if (!style) return;
  const body = Object.fromEntries(new FormData(elements.editStyleForm).entries());
  elements.editStyleSubmit.disabled = true;
  elements.editStyleSubmit.textContent = "正在保存…";
  try {
    await api(`/api/styles/${style.id}`, { method: "PATCH", body: JSON.stringify(body) });
    elements.editStyleDialog.close("saved");
    await Promise.all([loadStyles(), selectStyle(style.id, { force: true })]);
    toast("款式信息已保存。", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.editStyleSubmit.disabled = false;
    elements.editStyleSubmit.textContent = "保存修改";
  }
}

async function reconcile() {
  if (!state.selectedId) return;
  const button = $("#reconcile-button");
  button.disabled = true;
  button.textContent = "正在核对…";
  try {
    const payload = await api(`/api/styles/${state.selectedId}/reconcile`, { method: "POST", body: "{}" });
    state.status = payload.status;
    await loadStyles();
    renderStatus();
    toast(payload.repaired.length ? `已修复 ${payload.repaired.length} 条 D1 索引。` : "R2 与 D1 已一致，无需修复。");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "修复 D1 索引";
  }
}

async function togglePublish() {
  const style = state.status?.style;
  if (!style) return;
  const next = style.status === "published" ? "draft" : "published";
  if (next === "draft" && !window.confirm("将此款式转为草稿后，它会从公开款式列表中隐藏。是否继续？")) return;
  try {
    await api(`/api/styles/${style.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    await Promise.all([loadStyles(), selectStyle(style.id, { force: true })]);
    toast(next === "published" ? "款式已发布。" : "款式已转为草稿。", "success");
  } catch (error) {
    const missingCount = error.details?.missing?.length;
    toast(missingCount ? `还缺 ${missingCount} 个资源，不能发布。` : error.message, "error", 6500);
  }
}

elements.styleList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-style-id]");
  if (button) selectStyle(button.dataset.styleId);
});

elements.search.addEventListener("input", () => {
  state.search = elements.search.value;
  renderStyles();
});

$("#new-style-button").addEventListener("click", () => elements.newStyleDialog.showModal());
elements.newStyleForm.addEventListener("submit", createStyle);
elements.editStyleButton.addEventListener("click", openEditStyle);
elements.editStyleForm.addEventListener("submit", updateStyleMetadata);
$("#refresh-button").addEventListener("click", () => state.selectedId && selectStyle(state.selectedId, { force: true }));
$("#reconcile-button").addEventListener("click", reconcile);
$("#toggle-publish-button").addEventListener("click", togglePublish);
elements.startUpload.addEventListener("click", startUpload);
elements.clearStage.addEventListener("click", () => clearStaged());
$("#generate-thumbnail-button").addEventListener("click", generateThumbnail);

$("#batch-file-input").addEventListener("change", (event) => {
  handleBatchFiles(event.target.files);
  event.target.value = "";
});
$("#folder-file-input").addEventListener("change", (event) => {
  handleBatchFiles(event.target.files);
  event.target.value = "";
});
$("#thumbnail-file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    await stageFile(file, null, null, "cover");
    toast("缩略图已放入待提交区。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

const dropZone = $("#batch-drop-zone");
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => handleBatchFiles(event.dataTransfer.files));
dropZone.addEventListener("click", () => $("#batch-file-input").click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") $("#batch-file-input").click();
});

elements.matrix.addEventListener("change", async (event) => {
  if (!event.target.matches("[data-cell-input]")) return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await stageFile(file, event.target.dataset.tone, event.target.dataset.view);
    toast(`已放入 ${event.target.dataset.tone} / ${event.target.dataset.view}。`);
  } catch (error) {
    toast(error.message, "error");
  }
});

elements.matrix.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const key = cellKey(button.dataset.tone, button.dataset.view);
  if (button.dataset.action === "remove-stage") removeStage(key);
  if (button.dataset.action === "toggle-overwrite") {
    const stage = state.staged.get(key);
    stage.overwrite = !stage.overwrite;
    renderStatus();
  }
});

elements.matrix.addEventListener("dragover", (event) => {
  const cell = event.target.closest("[data-cell-tone]");
  if (!cell) return;
  event.preventDefault();
  cell.classList.add("is-dragging");
});
elements.matrix.addEventListener("dragleave", (event) => event.target.closest("[data-cell-tone]")?.classList.remove("is-dragging"));
elements.matrix.addEventListener("drop", async (event) => {
  const cell = event.target.closest("[data-cell-tone]");
  if (!cell) return;
  event.preventDefault();
  cell.classList.remove("is-dragging");
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  try {
    await stageFile(file, cell.dataset.cellTone, cell.dataset.cellView);
    toast(`已放入 ${cell.dataset.cellTone} / ${cell.dataset.cellView}。`);
  } catch (error) {
    toast(error.message, "error");
  }
});

elements.thumbnailAction.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const stage = state.staged.get("cover");
  if (button.dataset.action === "remove-cover") removeStage("cover");
  if (button.dataset.action === "toggle-cover-overwrite" && stage) {
    stage.overwrite = !stage.overwrite;
    renderStatus();
  }
});

elements.unmatchedList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  const row = event.target.closest("[data-unmatched-index]");
  if (!button || !row) return;
  const index = Number(row.dataset.unmatchedIndex);
  const entry = state.unmatched[index];
  if (!entry) return;
  if (button.dataset.action === "drop-unmatched") {
    state.unmatched.splice(index, 1);
    renderUnmatched();
    return;
  }
  const tone = row.querySelector("[data-manual-tone]").value;
  const view = row.querySelector("[data-manual-view]").value;
  const key = cellKey(tone, view);
  if (state.staged.has(key) && !window.confirm("该位置已有待提交图片，是否用当前文件替换？")) return;
  try {
    await stageFile(entry.file, tone, view);
    state.unmatched.splice(index, 1);
    renderUnmatched();
  } catch (error) {
    toast(error.message, "error");
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.busy && !state.staged.size) return;
  event.preventDefault();
  event.returnValue = "";
});

async function init() {
  try {
    await Promise.all([loadSession(), loadStyles()]);
    const first = state.styles[0];
    if (first) await selectStyle(first.id);
  } catch (error) {
    elements.operator.textContent = "连接失败";
    toast(error.message || "无法连接上传服务。", "error", 9000);
  }
}

init();
