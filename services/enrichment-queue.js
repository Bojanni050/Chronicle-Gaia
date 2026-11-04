'use strict';

/**
 * Wachtrij voor de achtergrond-verrijking van gecapturede gesprekken.
 *
 * Waarom: elk gesprek kost twee Gemini-calls (titel/summary/tags en een
 * embedding). Bij een grote import (tienduizenden items) liep dat voorheen
 * ongethrottled en zonder retry: bij een 429 mislukte de verrijking stil.
 *
 * Hier:
 *  - één worker tegelijk, met een vaste pauze tussen de generateContent-calls
 *    (throttle);
 *  - per ronde worden tot `batchSize` gesprekken verwerkt en hun embeddings in
 *    ÉÉN embedContent-request opgehaald (batching);
 *  - tijdelijke fouten (429, 5xx, netwerk) worden met exponentiële backoff
 *    herhaald; een mislukte embedding blokkeert de titel nooit.
 *
 * Alle I/O wordt geïnjecteerd, zodat de wachtrij zonder netwerk of database
 * te testen is.
 */

function isRetryable(err) {
  const status = err && (err.status ?? err.code);
  if (typeof status === 'number') return status === 429 || status >= 500;
  const msg = String((err && err.message) || '');
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|429|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg);
}

async function withRetry(fn, { maxAttempts, baseDelayMs, sleep, log, label }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log.warn(`[Chronicle] ${label} mislukt (poging ${attempt}/${maxAttempts}), opnieuw over ${delay}ms:`, err.message || err);
      await sleep(delay);
    }
  }
}

/**
 * @param {object} deps
 * @param {(id: string) => Promise<{content: string}|null>} deps.loadRow
 * @param {(row: object) => Promise<{suggestedTitle: string, summary?: string, tags?: string[]}|null>} deps.generateMeta
 *        null = niet mogelijk (bijv. geen API-key): het gesprek wordt overgeslagen.
 * @param {(texts: string[]) => Promise<(number[]|null)[]>} deps.embedBatch
 * @param {(id: string, meta: object, embedding: number[]|null) => Promise<void>} deps.saveRow
 * @param {(id: string, meta: object) => void} [deps.notify]
 */
function createEnrichmentQueue(deps) {
  const {
    loadRow,
    generateMeta,
    embedBatch,
    saveRow,
    notify = () => {},
    intervalMs = 1500,
    batchSize = 10,
    maxAttempts = 4,
    baseDelayMs = 2000,
    collectMs = 2000,
    embedTextLimit = 9000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console,
  } = deps;

  const pending = [];
  const queued = new Set();
  let running = false;
  let idle = Promise.resolve();

  const retryOpts = (label) => ({ maxAttempts, baseDelayMs, sleep, log, label });

  async function processBatch(ids) {
    const items = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      try {
        const row = await loadRow(id);
        if (!row) continue; // verwijderd in de tussentijd
        const meta = await withRetry(() => generateMeta(row), retryOpts('titel-verrijking'));
        if (meta && meta.suggestedTitle) items.push({ id, row, meta });
      } catch (err) {
        log.error('[Chronicle] title enrichment failed:', err.message || err);
      }
      if (i < ids.length - 1) await sleep(intervalMs);
    }
    if (!items.length) return;

    // Eén request voor alle embeddings van deze ronde.
    let embeddings = null;
    try {
      const texts = items.map(({ row, meta }) => `${row.content || ''}\n${meta.summary || ''}`.substring(0, embedTextLimit));
      const result = await withRetry(() => embedBatch(texts), retryOpts('embedding-batch'));
      if (Array.isArray(result) && result.length === items.length) embeddings = result;
      else log.warn('[Chronicle] capture embedding: onverwacht aantal resultaten, embeddings overgeslagen');
    } catch (err) {
      log.warn('[Chronicle] capture embedding failed:', err.message || err);
    }

    for (let i = 0; i < items.length; i += 1) {
      const { id, meta } = items[i];
      try {
        await saveRow(id, meta, (embeddings && embeddings[i]) || null);
        notify(id, meta);
      } catch (err) {
        log.error('[Chronicle] enrichment opslaan mislukt:', err.message || err);
      }
    }
  }

  async function run() {
    running = true;
    try {
      // Korte verzamelpauze: een burst van gesprekken belandt zo in één batch
      // in plaats van dat de eerste meteen alleen vertrekt.
      if (pending.length < batchSize) await sleep(collectMs);
      while (pending.length) {
        const ids = pending.splice(0, batchSize);
        try {
          await processBatch(ids);
        } finally {
          ids.forEach((id) => queued.delete(id));
        }
        if (pending.length) await sleep(intervalMs);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(id) {
    if (queued.has(id)) return;
    queued.add(id);
    pending.push(id);
    if (!running) idle = run();
  }

  return {
    enqueue,
    /** Resolvet zodra de wachtrij leeg is (voor tests en nette afsluiting). */
    onIdle: () => idle,
    size: () => pending.length,
  };
}

module.exports = { createEnrichmentQueue, isRetryable };
