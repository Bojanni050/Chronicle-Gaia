
/**
 * Deduplication keys for imports.
 *
 * A chat is identified by its conversation URL when it has one (exact, stable
 * across re-exports — ChatGPT's /c/<id>, Claude's /chat/<uuid>). When there is
 * no URL, the content hash is the fallback: it catches "exactly the same chat
 * twice", though a conversation that later grew will look new (documented
 * limitation, see findChatDuplicate).
 *
 * The content hash uses Foundation's own algorithm (server/contentHash.js) so
 * the two sides agree on identity — the same chat hashes the same on both.
 */

export interface DedupCandidate {
  url?: string;
  content: string;
}

export interface DedupKeys {
  /** Exact conversation identity, when a URL exists. */
  urlKey: string | null;
  /** Fallback identity from the transcript content. */
  contentHash: string;
}

/** Foundation's content hash (server/contentHash.js) — kept byte-for-byte. */
export function foundationContentHash(str: string): string {
  if (!str) return '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // force 32-bit integer
  }
  return 'ch_' + Math.abs(hash).toString(36);
}

/**
 * Normalises a URL for comparison: drops query and hash, trims a trailing
 * slash — the same normalisation Foundation's providerConversationId uses, so
 * two shapes of the same conversation URL still match.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}

export function dedupKeys(candidate: DedupCandidate): DedupKeys {
  const urlKey = candidate.url && candidate.url.trim() ? normalizeUrl(candidate.url) : null;
  return { urlKey, contentHash: foundationContentHash(candidate.content) };
}

export interface DedupHit {
  /** 'duplicate' when the content is identical; 'update' when it differs. */
  action: 'duplicate' | 'update';
}

interface ExistingChat extends DedupCandidate {
  id: string;
}

/**
 * Finds an already-imported chat that the candidate refers to, preferring the
 * exact URL key and falling back to the content hash.
 *
 * Returns:
 *   - { action: 'duplicate' } — same chat, identical content: do not import.
 *   - { action: 'update', existing } — same chat, different content: update it.
 *   - null — nothing matches; import as new.
 *
 * Known limitation: without a URL, two *different* chats that happen to have
 * identical content are indistinguishable and will be treated as duplicates.
 * That is the honest cost of the content-hash fallback for URL-less sources.
 */
export function findChatDuplicate(
  candidate: DedupCandidate,
  existingChats: ExistingChat[],
): (DedupHit & { existing: ExistingChat }) | null {
  const keys = dedupKeys(candidate);

  let match: ExistingChat | null = null;
  if (keys.urlKey) {
    match = existingChats.find((c) => c.url && normalizeUrl(c.url) === keys.urlKey) || null;
  }
  if (!match) {
    match = existingChats.find((c) => foundationContentHash(c.content) === keys.contentHash) || null;
  }
  if (!match) return null;

  const sameContent = foundationContentHash(match.content) === keys.contentHash;
  return { action: sameContent ? 'duplicate' : 'update', existing: match };
}
