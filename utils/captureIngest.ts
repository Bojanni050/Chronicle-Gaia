/**
 * Ingest-listener capture logic (main process).
 *
 * The ingest listener (services/ingest-listener.js) accepts a conversation in
 * the same raw shape utils/sourceParsers.ts produces (ParsedConversation) and
 * must do what the renderer's import flow (App.tsx handleUpload) does: dedup
 * against the archive, write the archive copy, and build the Foundation
 * payload. This module holds that pure logic in TypeScript so it reuses
 * buildChatIngestPayload / foundationContentHash / normalizeUrl verbatim
 * instead of drifting from the renderer. scripts/build-capture-ingest.js
 * transpiles it to utils/captureIngest.cjs for the CommonJS main process —
 * the same approach as utils/sourceParsers.cjs.
 */
import { buildChatIngestPayload, toSourceProvider, toFoundationRole, ChatIngestPayload, RawChatCapture } from './foundationCapture';
import { foundationContentHash, normalizeUrl } from './chatDedup';

// Re-exported so the transpiled .cjs keeps the same identity algorithm
// available to the CommonJS main process (the listener reuses it on rows).
export { foundationContentHash, normalizeUrl };

/**
 * One attachment that is already in the archive and in Foundation. The bytes
 * never travel with the chat: the plugin uploads them to POST /ingest/attachment
 * first and only sends these references along.
 */
export interface IngestAttachment {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  /** sha256 of Chronicle's local mirror (content-addressed blob). */
  hash?: string;
  /** Local viewer URL for the mirror (chronicle-asset://<hash>). */
  localUrl?: string;
}

/**
 * A file the plugin saw in the conversation but could not obtain. It stays on
 * the archive row as an honest record and never reaches Foundation: a chat must
 * not claim an attachment that does not exist there.
 */
export interface IngestAttachmentGap {
  filename?: string;
  mimeType?: string;
  reason: string;
}

/** Fields the listener accepts on POST /ingest/chat — the raw conversation. */
export interface IngestChatInput {
  content: string;
  turns?: Array<{ role?: string; text: string }>;
  title?: string;
  url?: string;
  sourceProvider?: string;
  occurredAt?: number | string;
  createdAt?: number | string;
  attachments?: IngestAttachment[];
  attachmentGaps?: IngestAttachmentGap[];
}

/** Server-owned fields Foundation refuses on every entry-point. */
const SERVER_OWNED_KEYS = [
  'status',
  'providerConversationId',
  'contentHash',
  'id',
  'ingestedAt',
  'updatedAt',
  'objectType',
];

/** Archive-derived fields that must stay in the archive, never reach Gaia. */
const DERIVED_KEYS = ['tags', 'summary', 'embedding', 'assets', 'links'];

const FORBIDDEN_KEYS = [...SERVER_OWNED_KEYS, ...DERIVED_KEYS];

const ALLOWED_KEYS = [
  'content',
  'turns',
  'title',
  'url',
  'sourceProvider',
  'occurredAt',
  'createdAt',
  'attachments',
  'attachmentGaps',
];

/**
 * Maps Foundation's lowercase provider name onto Chronicle's display source
 * (SourceType) so ingested chats group with their imported siblings.
 */
export function toSourceType(sourceProvider?: string): string {
  const key = (sourceProvider || '').trim().toLowerCase();
  const known: Record<string, string> = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    mistral: 'Mistral',
    qwen: 'Qwen',
    local: 'Local LLM',
    other: 'Other',
    manual: 'Manual',
  };
  return known[key] || 'Other';
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Accepts epoch seconds/ms or an ISO 8601 string; returns epoch ms. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value.trim());
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

export interface IngestValidation {
  error?: string;
  details?: string[];
}

/**
 * Strict input validation, mirroring Foundation's ingestPolicy.js behaviour:
 * unknown or server-owned/archive-derived fields are rejected by name so the
 * caller receives an honest 422 instead of a silently ignored payload.
 */
export function validateIngestChatInput(raw: any): IngestValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const details: string[] = [];
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      details.push(`"${key}" is server-owned and must not be sent`);
    } else if (!ALLOWED_KEYS.includes(key)) {
      details.push(`unknown field "${key}"`);
    }
  }
  if (typeof raw.content !== 'string' || !raw.content.trim()) {
    details.push('"content" is required and must be a non-empty string');
  }
  if (raw.turns !== undefined && !Array.isArray(raw.turns)) {
    details.push('"turns" must be an array of {role, text}');
  }
  if (raw.occurredAt !== undefined && toEpochMs(raw.occurredAt) === undefined) {
    details.push(`"occurredAt" is not a valid timestamp: ${String(raw.occurredAt)}`);
  }
  if (raw.createdAt !== undefined && toEpochMs(raw.createdAt) === undefined) {
    details.push(`"createdAt" is not a valid timestamp: ${String(raw.createdAt)}`);
  }
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments)) {
      details.push('"attachments" must be an array of {id, filename, mimeType, size, url}');
    } else {
      raw.attachments.forEach((att: any, i: number) => {
        if (!att || typeof att !== 'object' || Array.isArray(att)) {
          details.push(`"attachments[${i}]" must be an object`);
        } else if (typeof att.id !== 'string' || !att.id.trim()) {
          details.push(`"attachments[${i}].id" is required (the Foundation attachment id)`);
        }
      });
    }
  }
  if (raw.attachmentGaps !== undefined) {
    if (!Array.isArray(raw.attachmentGaps)) {
      details.push('"attachmentGaps" must be an array of {filename, mimeType, reason}');
    } else {
      raw.attachmentGaps.forEach((gap: any, i: number) => {
        if (!gap || typeof gap !== 'object' || typeof gap.reason !== 'string' || !gap.reason.trim()) {
          details.push(`"attachmentGaps[${i}].reason" is required`);
        }
      });
    }
  }
  if (details.length) return { error: 'invalid ingest payload', details };
  return {};
}

/**
 * Keeps only the attachment fields Chronicle stores. Foundation gets a stricter
 * subset (id/filename/mimeType/size/url) through buildChatIngestPayload; the
 * local hash and viewer URL are archive-only.
 */
function cleanAttachments(raw: unknown): IngestAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: IngestAttachment[] = [];
  for (const att of raw) {
    const id = cleanString(att && (att as any).id);
    if (!id) continue;
    const entry: IngestAttachment = { id };
    const filename = cleanString((att as any).filename);
    if (filename) entry.filename = filename;
    const mimeType = cleanString((att as any).mimeType);
    if (mimeType) entry.mimeType = mimeType;
    const size = Number((att as any).size);
    if (Number.isFinite(size) && size >= 0) entry.size = size;
    const url = cleanString((att as any).url);
    if (url) entry.url = url;
    const hash = cleanString((att as any).hash);
    if (hash && /^[0-9a-f]{64}$/i.test(hash)) entry.hash = hash.toLowerCase();
    const localUrl = cleanString((att as any).localUrl);
    if (localUrl) entry.localUrl = localUrl;
    out.push(entry);
  }
  return out;
}

/** Gaps are archive-only bookkeeping; an empty reason would hide a failure. */
function cleanGaps(raw: unknown): IngestAttachmentGap[] {
  if (!Array.isArray(raw)) return [];
  const out: IngestAttachmentGap[] = [];
  for (const gap of raw) {
    const reason = cleanString(gap && (gap as any).reason);
    if (!reason) continue;
    const entry: IngestAttachmentGap = { reason };
    const filename = cleanString((gap as any).filename);
    if (filename) entry.filename = filename;
    const mimeType = cleanString((gap as any).mimeType);
    if (mimeType) entry.mimeType = mimeType;
    out.push(entry);
  }
  return out;
}

export interface NormalizedIngestChat {
  /** Archive-shaped row values (the same columns save-database writes). */
  item: {
    id: string;
    type: 'chat';
    title: string;
    content: string;
    summary: string;
    tags: string[];
    source: string;
    createdAt: number;
    updatedAt: number;
    /** capture holds the raw fields for (re)sending to Foundation. */
    capture: {
      sourceProvider: string;
      turns: Array<{ role: 'user' | 'assistant'; text: string }>;
      occurredAt?: string;
      url?: string;
      attachments?: IngestAttachment[];
      attachmentGaps?: IngestAttachmentGap[];
    };
    /** Inline-viewable images, mirrored locally (chronicle-asset://<hash>). */
    assets?: string[];
    foundation: { status: 'pending'; at: number };
    contentHash: string;
  };
  /** Foundation's dedup identity: URL first, content hash as fallback. */
  urlKey: string | null;
  /** The exact body for POST {foundation}/api/ingest/chat. */
  foundationPayload: ChatIngestPayload;
}

/**
 * The archive date is the conversation's own moment (capture.occurredAt), not the
 * moment it was ingested: the UI sorts and displays by createdAt, so a chat
 * belongs on its real date. Falls back to `fallback` when the source carries no
 * time (e.g. a hand-written note). Shared with the DB load path, which uses it to
 * reconcile rows that were imported before this rule existed.
 */
export function archiveTimestamps(
  capture: { occurredAt?: string } | undefined | null,
  fallback: number
): { createdAt: number; updatedAt: number } {
  const ms = capture && capture.occurredAt ? Date.parse(capture.occurredAt) : NaN;
  const at = Number.isFinite(ms) ? ms : fallback;
  return { createdAt: at, updatedAt: at };
}

/**
 * Normalises a validated IngestChatInput into the archive item and the
 * Foundation payload. `id` is caller-supplied (crypto.randomUUID in the
 * listener) so this stays pure and testable.
 */
export function normalizeIngestChat(raw: IngestChatInput, id: string, now: number = Date.now()): NormalizedIngestChat {
  const content = cleanString(raw.content) as string;
  const turns = (raw.turns || [])
    .map((t: any) => ({ role: t?.role, text: cleanString(t?.text) }))
    .filter((t: any) => !!t.text);

  const title = cleanString(raw.title) || (content.slice(0, 80) || 'Untitled conversation');
  const sourceProvider = toSourceProvider(raw.sourceProvider) || 'other';
  const url = cleanString(raw.url);
  const occurredMs = toEpochMs(raw.occurredAt) ?? toEpochMs(raw.createdAt);

  const capture: NormalizedIngestChat['item']['capture'] = {
    sourceProvider,
    turns: turns.map((t: any) => ({ role: toFoundationRole(t.role), text: t.text as string })),
  };
  if (occurredMs !== undefined) capture.occurredAt = new Date(occurredMs).toISOString();
  if (url) capture.url = url;

  // Attachments are references to bytes that were uploaded before the chat
  // arrived (POST /ingest/attachment mirrors them locally and in Foundation).
  // Gaps are files the plugin saw but could not obtain: archive-only, so the
  // Foundation observation never claims a file it does not have.
  const attachments = cleanAttachments(raw.attachments);
  if (attachments.length) capture.attachments = attachments;
  const attachmentGaps = cleanGaps(raw.attachmentGaps);
  if (attachmentGaps.length) capture.attachmentGaps = attachmentGaps;

  // Images render inline in the viewer through Chronicle's local mirror; the
  // archive stores the URL, never the bytes (the blob on disk is the copy).
  const assets = attachments
    .filter((att) => (att.mimeType || '').toLowerCase().startsWith('image/') && att.localUrl)
    .map((att) => att.localUrl as string);

  // De archiefregel krijgt het originele gespreksmoment als createdAt, niet de
  // ingest-tijd: sorteren (App.filteredChats) en de datum op de kaart/zoekfilters
  // werken op createdAt, dus een geïmporteerde chat hoort op zijn echte datum te
  // staan. Valt terug op de ingest-tijd als de bron geen tijd meegaf.
  const { createdAt, updatedAt } = archiveTimestamps(capture, now);
  const foundationPayload = buildChatIngestPayload({
    content,
    title,
    sourceProvider,
    url,
    occurredAt: capture.occurredAt,
    turns: capture.turns,
    attachments,
  } as RawChatCapture);

  return {
    item: {
      id,
      type: 'chat',
      title,
      content,
      summary: '',
      tags: [],
      source: toSourceType(sourceProvider),
      createdAt,
      updatedAt,
      assets: assets.length ? assets : undefined,
      capture,
      foundation: { status: 'pending', at: now },
      contentHash: foundationContentHash(content),
    },
    urlKey: url ? normalizeUrl(url) : null,
    foundationPayload,
  };
}

export interface DedupRow {
  id: string;
  content: string;
  contentHash?: string | null;
  capture?: any;
}

/**
 * Finds an existing archive row for an ingested chat, preferring the exact
 * URL key and falling back to the content hash — the same identity rules as
 * the renderer's findChatDuplicate (utils/chatDedup.ts) and Foundation's own
 * dedup derivation.
 */
export function findExistingRow(rows: DedupRow[], urlKey: string | null, contentHash: string): DedupRow | null {
  if (urlKey) {
    const byUrl = rows.find((r) => {
      const rowUrl = r.capture?.url;
      return rowUrl && normalizeUrl(rowUrl) === urlKey;
    });
    if (byUrl) return byUrl;
  }
  return rows.find((r) => (r.contentHash || foundationContentHash(r.content)) === contentHash) || null;
}
