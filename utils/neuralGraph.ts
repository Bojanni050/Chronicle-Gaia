export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

interface TaggedItem {
  tags: string[];
}

// Tags carried by more than 15% of the chats link everything to everything and say
// nothing about how chats relate (e.g. "imported"): skipped entirely.
// Tags with many (but not that many) members would still cost members² pairs, so above
// ALL_PAIRS_LIMIT members each chat is only linked to a few members at fixed offsets in the list.
// Spread offsets (not just the next chats) make the tag form a round cluster instead of a chain.
const MAX_TAG_FRACTION = 0.15;
const MIN_TAG_MEMBERS = 10;
const ALL_PAIRS_LIMIT = 40;
const SPARSE_OFFSETS = [1, 7, 23];
const MAX_EDGES_PER_NODE = 6;

/**
 * Builds chat-to-chat edges from shared tags using an inverted tag index (no all-pairs
 * scan) and keeps each chat's strongest connections only. Returns index pairs into `items`.
 */
export const buildTagEdges = (items: TaggedItem[]): GraphEdge[] => {
  const n = items.length;
  const memberLimit = Math.max(MIN_TAG_MEMBERS, Math.floor(n * MAX_TAG_FRACTION));

  const byTag = new Map<string, number[]>();
  items.forEach((item, i) => {
    for (const tag of new Set(item.tags.map(t => t.toLowerCase()))) {
      const list = byTag.get(tag);
      if (list) list.push(i); else byTag.set(tag, [i]);
    }
  });

  const shared = new Map<number, number>(); // i * n + j (i < j) -> shared tag count
  for (const members of byTag.values()) {
    if (members.length < 2 || members.length > memberLimit) continue;
    const m = members.length;
    const add = (x: number, y: number) => {
      const key = Math.min(x, y) * n + Math.max(x, y);
      shared.set(key, (shared.get(key) || 0) + 1);
    };
    if (m <= ALL_PAIRS_LIMIT) {
      for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) add(members[a], members[b]);
    } else {
      for (let a = 0; a < m; a++) for (const off of SPARSE_OFFSETS) add(members[a], members[(a + off) % m]);
    }
  }

  const perNode: { key: number; count: number }[][] = items.map(() => []);
  for (const [key, count] of shared) {
    perNode[Math.floor(key / n)].push({ key, count });
    perNode[key % n].push({ key, count });
  }
  const keep = new Set<number>();
  for (const list of perNode) {
    list.sort((a, b) => b.count - a.count);
    for (const e of list.slice(0, MAX_EDGES_PER_NODE)) keep.add(e.key);
  }

  return Array.from(keep, key => ({
    source: Math.floor(key / n),
    target: key % n,
    weight: shared.get(key) || 1,
  }));
};
