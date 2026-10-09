// GENERATED from utils/sourceParsers.ts / utils/captureIngest.ts — do not edit by hand.
// Rebuild with: npm run build:parsers
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// utils/captureIngest.ts
var captureIngest_exports = {};
__export(captureIngest_exports, {
  archiveTimestamps: () => archiveTimestamps,
  findExistingRow: () => findExistingRow,
  foundationContentHash: () => foundationContentHash,
  normalizeIngestChat: () => normalizeIngestChat,
  normalizeUrl: () => normalizeUrl,
  toSourceType: () => toSourceType,
  validateIngestChatInput: () => validateIngestChatInput
});
module.exports = __toCommonJS(captureIngest_exports);

// utils/foundationCapture.ts
var CHRONICLE_CAPTURE_SOURCE = "chronicle-capture";
var SERVER_OWNED_KEYS = [
  "status",
  "providerConversationId",
  "contentHash",
  "id",
  "ingestedAt",
  "updatedAt",
  "objectType"
];
var DERIVED_KEYS = ["tags", "summary", "embedding", "assets", "links"];
var FORBIDDEN_KEYS = [...SERVER_OWNED_KEYS, ...DERIVED_KEYS];
function clean(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed : void 0;
}
function toFoundationRole(role) {
  const r = (role || "").trim().toLowerCase();
  if (["user", "human", "you", "me"].includes(r)) return "user";
  return "assistant";
}
function normalizeTurns(turns) {
  if (!Array.isArray(turns)) return [];
  const out = [];
  for (const turn of turns) {
    const text = clean(turn && turn.text);
    if (!text) continue;
    out.push({ role: toFoundationRole(turn.role), text });
  }
  return out;
}
function toSourceProvider(source) {
  const raw = clean(source);
  if (!raw) return void 0;
  const key = raw.toLowerCase();
  const known = {
    chatgpt: "chatgpt",
    claude: "claude",
    gemini: "gemini",
    mistral: "mistral",
    qwen: "qwen",
    "local llm": "local",
    other: "other",
    manual: "manual"
  };
  return known[key] || key.replace(/\s+/g, "-");
}
function buildChatIngestPayload(raw) {
  const content = clean(raw && raw.content);
  if (!content) throw new Error("capture payload requires a non-empty content");
  const payload = {
    content,
    source: CHRONICLE_CAPTURE_SOURCE
  };
  const title = clean(raw.title);
  if (title) payload.title = title;
  const sourceProvider = clean(raw.sourceProvider);
  if (sourceProvider) payload.sourceProvider = sourceProvider;
  const url = clean(raw.url);
  if (url) payload.url = url;
  const occurredAt = clean(raw.occurredAt);
  if (occurredAt) {
    if (Number.isNaN(Date.parse(occurredAt))) {
      throw new Error(`occurredAt is not a valid ISO 8601 timestamp: ${occurredAt}`);
    }
    payload.occurredAt = occurredAt;
  }
  const turns = normalizeTurns(raw.turns);
  if (turns.length) payload.turns = turns;
  const attachments = normalizeAttachments(raw.attachments);
  if (attachments.length) payload.attachments = attachments;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`capture payload must not carry "${key}"`);
    }
  }
  return payload;
}
function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const att of attachments) {
    const id = clean(att && att.id);
    if (!id) continue;
    const entry = { id };
    const filename = clean(att.filename);
    if (filename) entry.filename = filename;
    const mimeType = clean(att.mimeType);
    if (mimeType) entry.mimeType = mimeType;
    if (typeof att.size === "number" && Number.isFinite(att.size)) entry.size = att.size;
    const url = clean(att.url);
    if (url) entry.url = url;
    out.push(entry);
  }
  return out;
}

// utils/chatDedup.ts
function foundationContentHash(str) {
  if (!str) return "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return "ch_" + Math.abs(hash).toString(36);
}
function normalizeUrl(url) {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

// utils/captureIngest.ts
var SERVER_OWNED_KEYS2 = [
  "status",
  "providerConversationId",
  "contentHash",
  "id",
  "ingestedAt",
  "updatedAt",
  "objectType"
];
var DERIVED_KEYS2 = ["tags", "summary", "embedding", "assets", "links"];
var FORBIDDEN_KEYS2 = [...SERVER_OWNED_KEYS2, ...DERIVED_KEYS2];
var ALLOWED_KEYS = ["content", "turns", "title", "url", "sourceProvider", "occurredAt", "createdAt"];
function toSourceType(sourceProvider) {
  const key = (sourceProvider || "").trim().toLowerCase();
  const known = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
    mistral: "Mistral",
    qwen: "Qwen",
    local: "Local LLM",
    other: "Other",
    manual: "Manual"
  };
  return known[key] || "Other";
}
function cleanString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed : void 0;
}
function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1e3;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value.trim());
    if (!Number.isNaN(ms)) return ms;
  }
  return void 0;
}
function validateIngestChatInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const details = [];
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS2.includes(key)) {
      details.push(`"${key}" is server-owned and must not be sent`);
    } else if (!ALLOWED_KEYS.includes(key)) {
      details.push(`unknown field "${key}"`);
    }
  }
  if (typeof raw.content !== "string" || !raw.content.trim()) {
    details.push('"content" is required and must be a non-empty string');
  }
  if (raw.turns !== void 0 && !Array.isArray(raw.turns)) {
    details.push('"turns" must be an array of {role, text}');
  }
  if (raw.occurredAt !== void 0 && toEpochMs(raw.occurredAt) === void 0) {
    details.push(`"occurredAt" is not a valid timestamp: ${String(raw.occurredAt)}`);
  }
  if (raw.createdAt !== void 0 && toEpochMs(raw.createdAt) === void 0) {
    details.push(`"createdAt" is not a valid timestamp: ${String(raw.createdAt)}`);
  }
  if (details.length) return { error: "invalid ingest payload", details };
  return {};
}
function archiveTimestamps(capture, fallback) {
  const ms = capture && capture.occurredAt ? Date.parse(capture.occurredAt) : NaN;
  const at = Number.isFinite(ms) ? ms : fallback;
  return { createdAt: at, updatedAt: at };
}
function normalizeIngestChat(raw, id, now = Date.now()) {
  const content = cleanString(raw.content);
  const turns = (raw.turns || []).map((t) => ({ role: t?.role, text: cleanString(t?.text) })).filter((t) => !!t.text);
  const title = cleanString(raw.title) || (content.slice(0, 80) || "Untitled conversation");
  const sourceProvider = toSourceProvider(raw.sourceProvider) || "other";
  const url = cleanString(raw.url);
  const occurredMs = toEpochMs(raw.occurredAt) ?? toEpochMs(raw.createdAt);
  const capture = {
    sourceProvider,
    turns: turns.map((t) => ({ role: toFoundationRole(t.role), text: t.text }))
  };
  if (occurredMs !== void 0) capture.occurredAt = new Date(occurredMs).toISOString();
  if (url) capture.url = url;
  const { createdAt, updatedAt } = archiveTimestamps(capture, now);
  const foundationPayload = buildChatIngestPayload({
    content,
    title,
    sourceProvider,
    url,
    occurredAt: capture.occurredAt,
    turns: capture.turns
  });
  return {
    item: {
      id,
      type: "chat",
      title,
      content,
      summary: "",
      tags: [],
      source: toSourceType(sourceProvider),
      createdAt,
      updatedAt,
      capture,
      foundation: { status: "pending", at: now },
      contentHash: foundationContentHash(content)
    },
    urlKey: url ? normalizeUrl(url) : null,
    foundationPayload
  };
}
function findExistingRow(rows, urlKey, contentHash) {
  if (urlKey) {
    const byUrl = rows.find((r) => {
      const rowUrl = r.capture?.url;
      return rowUrl && normalizeUrl(rowUrl) === urlKey;
    });
    if (byUrl) return byUrl;
  }
  return rows.find((r) => (r.contentHash || foundationContentHash(r.content)) === contentHash) || null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  archiveTimestamps,
  findExistingRow,
  foundationContentHash,
  normalizeIngestChat,
  normalizeUrl,
  toSourceType,
  validateIngestChatInput
});
