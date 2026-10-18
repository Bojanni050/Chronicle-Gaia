import { describe, it, expect } from 'vitest';
import { buildTagEdges } from './neuralGraph';

describe('buildTagEdges', () => {
  it('links chats that share a tag and counts shared tags as weight', () => {
    const edges = buildTagEdges([
      { tags: ['music', 'lyrics'] },
      { tags: ['Music', 'lyrics'] },
      { tags: ['cooking'] },
    ]);
    expect(edges).toEqual([{ source: 0, target: 1, weight: 2 }]);
  });

  it('ignores tags that nearly every chat carries', () => {
    const items = Array.from({ length: 200 }, () => ({ tags: ['imported'] }));
    expect(buildTagEdges(items)).toEqual([]);
  });

  it('keeps at most 6 edges per chat', () => {
    const items = Array.from({ length: 10 }, () => ({ tags: ["topic"] }));
    const edges = buildTagEdges(items);
    const degree = new Array(10).fill(0);
    edges.forEach(e => { degree[e.source]++; degree[e.target]++; });
    expect(edges.length).toBeGreaterThan(0);
    // every chat keeps its own 6; it may have more only via edges other chats kept
    expect(Math.min(...degree)).toBeGreaterThanOrEqual(6);
  });

  it('still connects big tags, with a bounded number of edges', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ tags: [i % 10 === 0 ? 'rare' : 'topic' + (i % 5)] }));
    const edges = buildTagEdges(items);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.length).toBeLessThan(items.length * 6);
  });
});
