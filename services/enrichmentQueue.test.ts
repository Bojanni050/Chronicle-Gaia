import { describe, it, expect, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createEnrichmentQueue, isRetryable } = require('./enrichment-queue');

const silent = { warn: () => {}, error: () => {}, log: () => {} };

function setup(overrides: Record<string, unknown> = {}) {
  const saved: Array<{ id: string; title: string; embedding: number[] | null }> = [];
  const embedBatch = vi.fn(async (texts: string[]) => texts.map((_, i) => [i + 1]));
  const generateMeta = vi.fn(async (row: { content: string }) => ({
    suggestedTitle: `T-${row.content}`,
    summary: 's',
    tags: ['a'],
  }));
  const sleep = vi.fn(async () => {});
  const queue = createEnrichmentQueue({
    loadRow: async (id: string) => ({ content: id }),
    generateMeta,
    embedBatch,
    saveRow: async (id: string, meta: { suggestedTitle: string }, embedding: number[] | null) => {
      saved.push({ id, title: meta.suggestedTitle, embedding });
    },
    sleep,
    log: silent,
    intervalMs: 10,
    baseDelayMs: 5,
    ...overrides,
  });
  return { queue, saved, embedBatch, generateMeta, sleep };
}

describe('isRetryable', () => {
  it('retries 429 and 5xx, not 4xx', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(isRetryable(new Error('bad schema'))).toBe(false);
  });
});

describe('enrichment queue', () => {
  it('embeds a whole round in ONE batch request', async () => {
    const { queue, saved, embedBatch } = setup({ batchSize: 3 });
    ['a', 'b', 'c'].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0][0]).toHaveLength(3);
    expect(saved.map((s) => s.embedding)).toEqual([[1], [2], [3]]);
  });

  it('splits more items than batchSize over multiple rounds', async () => {
    const { queue, saved, embedBatch } = setup({ batchSize: 2 });
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(embedBatch).toHaveBeenCalledTimes(3);
    expect(saved).toHaveLength(5);
  });

  it('ignores a chat that is already queued', async () => {
    const { queue, generateMeta } = setup();
    queue.enqueue('a');
    queue.enqueue('a');
    await queue.onIdle();
    expect(generateMeta).toHaveBeenCalledTimes(1);
  });

  it('throttles between generate calls', async () => {
    const { queue, sleep } = setup({ batchSize: 3 });
    ['a', 'b', 'c'].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(sleep).toHaveBeenCalledWith(10);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a 429 with backoff and then succeeds', async () => {
    let calls = 0;
    const generateMeta = vi.fn(async (row: { content: string }) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('quota'), { status: 429 });
      return { suggestedTitle: `T-${row.content}`, summary: '', tags: [] };
    });
    const { queue, saved, sleep } = setup({ generateMeta });
    queue.enqueue('a');
    await queue.onIdle();
    expect(generateMeta).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(5);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(saved).toHaveLength(1);
  });

  it('does not retry a permanent error and skips that chat only', async () => {
    const generateMeta = vi.fn(async (row: { content: string }) => {
      if (row.content === 'bad') throw Object.assign(new Error('bad request'), { status: 400 });
      return { suggestedTitle: `T-${row.content}`, summary: '', tags: [] };
    });
    const { queue, saved } = setup({ generateMeta });
    ['bad', 'good'].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(generateMeta).toHaveBeenCalledTimes(2);
    expect(saved.map((s) => s.id)).toEqual(['good']);
  });

  it('still saves the title when the embedding batch fails', async () => {
    const embedBatch = vi.fn(async () => {
      throw Object.assign(new Error('down'), { status: 400 });
    });
    const { queue, saved } = setup({ embedBatch });
    queue.enqueue('a');
    await queue.onIdle();
    expect(saved).toEqual([{ id: 'a', title: 'T-a', embedding: null }]);
  });

  it('skips embeddings when the result count does not match', async () => {
    const { queue, saved } = setup({ embedBatch: async () => [[1]], batchSize: 2 });
    ['a', 'b'].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(saved.map((s) => s.embedding)).toEqual([null, null]);
  });

  it('skips a chat without API key (generateMeta returns null)', async () => {
    const { queue, saved, embedBatch } = setup({ generateMeta: async () => null });
    queue.enqueue('a');
    await queue.onIdle();
    expect(saved).toHaveLength(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });
});
