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

/** Fields the listener accepts on POST /ingest/chat — the raw conversation. */
export interface IngestChatInput {
  content: string;
  turns?: Array<{ role?: string; text: string }>;
  title?: string;
  url?: string;
  sourceProvider?: string;
  occurredAt?: number | string;
  createdAt?: number | string;
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

const ALLOWED_KEYS = ['content', 'turns', 'title', 'url', 'sourceProvider', 'occurredAt', 'createdAt'];

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
  if (details.length) return { error: 'invalid ingest payload', details };
  return {};
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
    };
    foundation: { status: 'pending'; at: number };
    contentHash: string;
  };
  /** Foundation's dedup identity: URL first, content hash as fallback. */
  urlKey: string | null;
  /** The exact body for POST {foundation}/api/ingest/chat. */
  foundationPayload: ChatIngestPayload;
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
  const occurredMs = toEpochMs(raw.occurredAt);
  const createdMs = toEpochMs(raw.createdAt) ?? occurredMs ?? now;

  const capture: NormalizedIngestChat['item']['capture'] = {
    sourceProvider,
    turns: turns.map((t: any) => ({ role: toFoundationRole(t.role), text: t.text as string })),
  };
  if (occurredMs !== undefined) capture.occurredAt = new Date(occurredMs).toISOString();
  if (url) capture.url = url;

  // The Foundation payload uses exactly the raw fields the gateway allows —
  // built by the same builder the renderer's captureToFoundation uses.
  const foundationPayload = buildChatIngestPayload({
    content,
    title,
    sourceProvider,
    url,
    occurredAt: capture.occurredAt,
    turns: capture.turns,
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
      createdAt: createdMs,
      updatedAt: now,
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
