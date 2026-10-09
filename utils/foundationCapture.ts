
/**
 * Chronicle → Foundation capture payload.
 *
 * The ONLY thing that crosses from Chronicle into Gaia is the raw chat:
 * content, title, sourceProvider, url, occurredAt and turns. Derived archive
 * data (summary, tags, embeddings, assets, links) must never enter this
 * payload — see Gaia-Documentation/capture-chronicle.md.
 *
 * The builder is intentionally strict. It emits exactly the fields the `chat`
 * entry-point of Foundation's Ingestie Gateway allows (server/ingestPolicy.js)
 * and never a server-owned one (`status`, `providerConversationId`,
 * `contentHash`, `id`, `objectType`, ...). A typo'd or derived field fails
 * loudly on the Foundation side with a 422; this module makes sure we never
 * produce one to begin with.
 */

import { parseChatMessages } from './chatUtils';

export type FoundationTurnRole = 'user' | 'assistant';

export interface FoundationTurn {
  role: FoundationTurnRole;
  text: string;
}

/**
 * An attachment already uploaded to Foundation, referenced on the chat. Only
 * metadata crosses here — the bytes live in Foundation's attachment store.
 */
export interface FoundationAttachment {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  url?: string;
}

/**
 * The raw, source-agnostic shape of one chat as it crosses into Foundation.
 * Everything here is either the chat itself or where it came from — nothing
 * about what we think of it.
 */
export interface RawChatCapture {
  content: string;
  title?: string;
  sourceProvider?: string;
  url?: string;
  occurredAt?: string;
  turns?: Array<{ role?: string; text: string }>;
  attachments?: FoundationAttachment[];
}

export interface ChatIngestPayload {
  content: string;
  source: string;
  title?: string;
  sourceProvider?: string;
  url?: string;
  occurredAt?: string;
  turns?: FoundationTurn[];
  attachments?: FoundationAttachment[];
}

/** The `source` value Foundation records for chats delivered by Chronicle. */
export const CHRONICLE_CAPTURE_SOURCE = 'chronicle-capture';

/** Fields Foundation refuses on every entry-point — server-owned, never ours. */
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

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Maps an arbitrary role label onto Foundation's canonical two roles. Anything
 * that is not clearly the human side is treated as the assistant side, which
 * matches the shape the existing importers deliver ({role: "user"|"assistant"}).
 */
export function toFoundationRole(role?: string): FoundationTurnRole {
  const r = (role || '').trim().toLowerCase();
  if (['user', 'human', 'you', 'me'].includes(r)) return 'user';
  return 'assistant';
}

function normalizeTurns(turns: RawChatCapture['turns']): FoundationTurn[] {
  if (!Array.isArray(turns)) return [];
  const out: FoundationTurn[] = [];
  for (const turn of turns) {
    const text = clean(turn && turn.text);
    if (!text) continue;
    out.push({ role: toFoundationRole(turn.role), text });
  }
  return out;
}

/**
 * Maps Chronicle's source label (SourceType) onto the lowercase provider name
 * Foundation's dedup derivation expects (chatgpt / claude / gemini / ...).
 */
export function toSourceProvider(source?: string): string | undefined {
  const raw = clean(source);
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  const known: Record<string, string> = {
    chatgpt: 'chatgpt',
    claude: 'claude',
    gemini: 'gemini',
    mistral: 'mistral',
    qwen: 'qwen',
    'local llm': 'local',
    other: 'other',
    manual: 'manual',
  };
  return known[key] || key.replace(/\s+/g, '-');
}

/**
 * Builds the exact body for `POST /api/ingest/chat`. Throws on a hard contract
 * violation (empty content, unparseable occurredAt) so the caller can decide
 * not to send rather than ship an invalid payload.
 */
export function buildChatIngestPayload(raw: RawChatCapture): ChatIngestPayload {
  const content = clean(raw && raw.content);
  if (!content) throw new Error('capture payload requires a non-empty content');

  const payload: ChatIngestPayload = {
    content,
    source: CHRONICLE_CAPTURE_SOURCE,
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

  // Belt-and-braces: a forbidden key can never survive construction, but if a
  // future edit ever spreads raw fields in, this makes the violation loud.
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`capture payload must not carry "${key}"`);
    }
  }

  return payload;
}

function normalizeAttachments(attachments: RawChatCapture['attachments']): FoundationAttachment[] {
  if (!Array.isArray(attachments)) return [];
  const out: FoundationAttachment[] = [];
  for (const att of attachments) {
    const id = clean(att && att.id);
    if (!id) continue; // Foundation requires an id on every attachment
    const entry: FoundationAttachment = { id };
    const filename = clean(att.filename);
    if (filename) entry.filename = filename;
    const mimeType = clean(att.mimeType);
    if (mimeType) entry.mimeType = mimeType;
    if (typeof att.size === 'number' && Number.isFinite(att.size)) entry.size = att.size;
    const url = clean(att.url);
    if (url) entry.url = url;
    out.push(entry);
  }
  return out;
}

/**
 * Derives Foundation turns from a raw transcript using the same parser the
 * archive viewer uses. This is a structural split of the existing text (who
 * said what), not interpretation — the content itself is unchanged. Roles map
 * onto Foundation's two canonical roles; empty turns are dropped.
 */
export function turnsFromTranscript(content: string, baseTime: number = Date.now()): FoundationTurn[] {
  return parseChatMessages(content, baseTime)
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({ role: toFoundationRole(m.role), text: m.text }));
}
