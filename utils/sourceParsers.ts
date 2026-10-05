
/**
 * Source-shape parsing: turning an exported chat file into the raw form
 * Foundation records — content, turns, url, sourceProvider, occurredAt.
 *
 * This is a *structural* parse (who said what, which conversation this is),
 * not interpretation. The content that ends up in `content` is the chat as it
 * was exported; nothing is summarised, tagged or reordered here.
 *
 * Three export shapes are understood:
 *   - Claude (conversations.json): { uuid, name, created_at, updated_at,
 *     chat_messages: [{ sender, text, content }] }
 *   - ChatGPT (mapping tree): { title, create_time, update_time, mapping: {...} }
 *   - plain JSON arrays / {messages|history|conversation} (existing behaviour)
 */

export type ParsedSourceProvider = 'chatgpt' | 'claude' | 'gemini' | 'qwen' | 'local' | 'other';

export interface ParsedTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ParsedConversation {
  content: string;
  turns: ParsedTurn[];
  title?: string;
  url?: string;
  sourceProvider?: ParsedSourceProvider;
  /** Conversation creation time (ms). */
  createdAt?: number;
  /** Last activity time (ms) — used as occurredAt. */
  occurredAt?: number;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function formatTurns(turns: ParsedTurn[]): string {
  return turns.map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`).join('\n\n');
}

function titleFrom(turns: ParsedTurn[], explicit?: unknown, fallback = 'Untitled'): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const firstUser = turns.find((t) => t.role === 'user');
  return (firstUser?.text || turns[0]?.text || fallback).slice(0, 80);
}

// ── Claude export ────────────────────────────────────────────────────────────

function messageText(msg: any): string {
  // Prefer structured content blocks (text only), fall back to the flattened
  // text field — mirrors Foundation's own claude_export.py.
  const blocks = msg?.content;
  const parts = Array.isArray(blocks)
    ? blocks
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string' && b.text)
        .map((b: any) => b.text)
    : [];
  let text = parts.length ? parts.join('\n\n') : typeof msg?.text === 'string' ? msg.text : '';
  const extras: string[] = [];
  for (const att of msg?.attachments || []) {
    if (att?.extracted_content) extras.push(`[Attached: ${att.file_name || 'attachment'}]\n${att.extracted_content}`);
  }
  for (const f of msg?.files || []) {
    extras.push(`[Attached: ${f?.file_name || 'file'} — content not included in this export]`);
  }
  if (extras.length) text = [text, ...extras].filter(Boolean).join('\n\n');
  return text.trim();
}

function claudeTurns(chatMessages: any[]): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const msg of chatMessages) {
    const text = messageText(msg);
    if (!text) continue;
    turns.push({ role: msg?.sender === 'assistant' ? 'assistant' : 'user', text });
  }
  return turns;
}

export function parseClaudeConversation(conv: any): ParsedConversation | null {
  const turns = claudeTurns(Array.isArray(conv?.chat_messages) ? conv.chat_messages : []);
  if (!turns.length) return null;
  const uuid = typeof conv?.uuid === 'string' ? conv.uuid : undefined;
  return {
    content: formatTurns(turns),
    turns,
    title: titleFrom(turns, conv?.name, 'Untitled Claude conversation'),
    url: uuid ? `https://claude.ai/chat/${uuid}` : undefined,
    sourceProvider: 'claude',
    createdAt: parseTime(conv?.created_at),
    occurredAt: parseTime(conv?.updated_at) ?? parseTime(conv?.created_at),
  };
}

// ── ChatGPT export (mapping tree) ────────────────────────────────────────────

function mappingToOrderedMessages(mapping: Record<string, any>): any[] {
  const nodes = Object.values(mapping || {});
  const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
  const roots = nodes.filter((n: any) => !n.parent || !byId.has(n.parent));
  const ordered: any[] = [];
  const seen = new Set<string>();
  const walk = (node: any) => {
    if (!node || seen.has(node.id)) return; // guard against cycles / diamond parents
    seen.add(node.id);
    if (node.message) ordered.push(node.message);
    (node.children || []).forEach((childId: string) => walk(byId.get(childId)));
  };
  roots.forEach(walk);
  return ordered;
}

function chatgptMessageText(msg: any): string {
  const parts = msg?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => typeof p === 'string' && p.trim())
      .join('\n')
      .trim();
  }
  if (typeof msg?.content?.text === 'string') return msg.content.text.trim();
  return '';
}

function chatgptTurns(orderedMessages: any[]): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const msg of orderedMessages) {
    const authorRole = msg?.author?.role;
    // Skip the hidden system prompt and tool/internal messages.
    if (!authorRole || authorRole === 'system' || authorRole === 'tool') continue;
    const text = chatgptMessageText(msg);
    if (!text) continue;
    turns.push({ role: authorRole === 'user' ? 'user' : 'assistant', text });
  }
  return turns;
}

export function parseChatGPTConversation(root: any): ParsedConversation | null {
  const ordered = mappingToOrderedMessages(root?.mapping);
  const turns = chatgptTurns(ordered);
  if (!turns.length) return null;
  const firstMessageTime = ordered.find((m: any) => m?.create_time)?.create_time;
  const occurredAt = parseTime(root?.update_time) ?? parseTime(firstMessageTime);
  return {
    content: formatTurns(turns),
    turns,
    title: titleFrom(turns, root?.title, 'Untitled ChatGPT conversation'),
    sourceProvider: 'chatgpt',
    createdAt: parseTime(root?.create_time) ?? parseTime(firstMessageTime),
    occurredAt,
  };
}

// ── Claude export (array container) ──────────────────────────────────────────

export function parseClaudeExport(json: any): ParsedConversation[] {
  const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : [];
  return list.map(parseClaudeConversation).filter((c: ParsedConversation | null): c is ParsedConversation => !!c);
}

// ── Generic array / messages container (existing behaviour) ──────────────────

const USER_ROLES = ['user', 'human', 'you'];
const ASSISTANT_ROLES = ['assistant', 'model', 'bot', 'gpt', 'qwen', 'ai'];

function genericTurns(messages: any[]): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const msg of messages) {
    const role = String(msg?.role ?? msg?.from ?? (msg?.type === 'human' ? 'user' : 'model')).toLowerCase();
    const content = msg?.content ?? msg?.value ?? msg?.text ?? '';
    const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map(String).join('\n') : '').trim();
    if (!text) continue;
    if (USER_ROLES.includes(role)) turns.push({ role: 'user', text });
    else if (ASSISTANT_ROLES.includes(role)) turns.push({ role: 'assistant', text });
  }
  return turns;
}

function genericMessages(json: any): any[] | null {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.messages)) return json.messages;
    if (Array.isArray(json.history)) return json.history;
    if (Array.isArray(json.conversation)) return json.conversation;
  }
  return null;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/** Detects the export shape and parses it into one conversation. */
export function parseConversationJson(json: any): ParsedConversation | null {
  if (json && typeof json === 'object' && json.mapping) return parseChatGPTConversation(json);

  const messages = genericMessages(json);
  if (messages) {
    const turns = genericTurns(messages);
    if (!turns.length) return null;
    const root = Array.isArray(json) ? undefined : json;
    return {
      content: formatTurns(turns),
      turns,
      title: titleFrom(turns, root?.title),
      sourceProvider: 'other',
      createdAt: parseTime(root?.createdAt ?? root?.create_time ?? root?.created_at),
      occurredAt: parseTime(root?.updatedAt ?? root?.update_time ?? root?.updated_at),
    };
  }

  return parseClaudeConversation(json);
}

