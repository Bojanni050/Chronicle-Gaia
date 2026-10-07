/**
 * chatgpt.com provider-script. Haalt het huidige gesprek op via de interne
 * API (GET /backend-api/conversation/{id} met de sessie-cookie), met een
 * DOM-fallback. Normaliseert naar de ParsedConversation-vorm (mapping-tree
 * → geordende turns, zelfde regels als utils/sourceParsers.ts) en levert af
 * via de service worker.
 */
import { makeButton, exportToChronicle, buildConversation } from './normalize.js';

function conversationIdFromUrl() {
  const match = location.pathname.match(/\/c\/([0-9a-f-]{16,})/i);
  return match ? match[1] : null;
}

async function fetchConversation(id) {
  const res = await fetch(`/backend-api/conversation/${id}`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`chatgpt API ${res.status}`);
  return res.json();
}

function mappingToOrderedMessages(mapping) {
  const nodes = Object.values(mapping || {});
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !n.parent || !byId.has(n.parent));
  const ordered = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    if (node.message) ordered.push(node.message);
    (node.children || []).forEach((childId) => walk(byId.get(childId)));
  };
  roots.forEach(walk);
  return ordered;
}

function messageText(msg) {
  const parts = msg?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((p) => typeof p === 'string' && p.trim()).join('\n').trim();
  }
  if (typeof msg?.content?.text === 'string') return msg.content.text.trim();
  return '';
}

function turnsFromApi(root) {
  const turns = [];
  for (const msg of mappingToOrderedMessages(root.mapping)) {
    const role = msg?.author?.role;
    if (!role || role === 'system' || role === 'tool') continue;
    const text = messageText(msg);
    if (!text) continue;
    turns.push({ role: role === 'user' ? 'user' : 'assistant', text });
  }
  return turns;
}

function turnsFromDom() {
  const turns = [];
  const blocks = document.querySelectorAll('[data-message-author-role]');
  for (const block of blocks) {
    const role = block.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') continue;
    const text = (block.innerText || '').trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

function transcriptFromTurns(turns) {
  return turns
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
    .join('\n\n');
}

async function collectConversation() {
  const id = conversationIdFromUrl();
  let turns = null;
  let title = null;
  let occurredAt = null;
  if (id) {
    try {
      const root = await fetchConversation(id);
      turns = turnsFromApi(root);
      title = typeof root.title === 'string' && root.title.trim() ? root.title.trim() : null;
      occurredAt = root.update_time || root.create_time || null;
    } catch {
      turns = null; // val door naar de DOM-fallback
    }
  }
  if (!turns || !turns.length) {
    turns = turnsFromDom();
  }
  if (!turns.length) {
    return { error: 'geen berichten gevonden op deze pagina' };
  }
  return buildConversation({
    content: transcriptFromTurns(turns),
    turns,
    title,
    url: id ? `https://chatgpt.com/c/${id}` : location.href,
    sourceProvider: 'chatgpt',
    occurredAt,
  });
}

makeButton(async (event) => {
  const button = event.currentTarget;
  const conv = await collectConversation();
  if (conv.error) {
    button.textContent = '✗ ' + conv.error;
    setTimeout(() => (button.textContent = '→ Chronicle'), 4000);
    return;
  }
  await exportToChronicle(button, conv);
});
