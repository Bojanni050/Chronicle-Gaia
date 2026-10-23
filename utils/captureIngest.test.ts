import { describe, it, expect } from 'vitest';
import {
  validateIngestChatInput,
  normalizeIngestChat,
  archiveTimestamps,
  findExistingRow,
  toSourceType,
} from './captureIngest';

const VALID = {
  content: 'User: hi\n\nAssistant: hello there',
  turns: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello there' },
  ],
  title: 'Test conversation',
  url: 'https://claude.ai/chat/abc-123',
  sourceProvider: 'claude',
  occurredAt: 1760000000000,
};

describe('validateIngestChatInput', () => {
  it('accepts the raw conversation shape', () => {
    expect(validateIngestChatInput(VALID)).toEqual({});
  });

  it('accepts the minimal shape (content only)', () => {
    expect(validateIngestChatInput({ content: 'anything' })).toEqual({});
  });

  it('requires non-empty content', () => {
    const res = validateIngestChatInput({ content: '   ' });
    expect(res.error).toBe('invalid ingest payload');
    expect(res.details).toContain('"content" is required and must be a non-empty string');
  });

  it('rejects server-owned fields by name', () => {
    const res = validateIngestChatInput({ ...VALID, status: 'sent', providerConversationId: 'x' });
    expect(res.details).toContain('"status" is server-owned and must not be sent');
    expect(res.details).toContain('"providerConversationId" is server-owned and must not be sent');
  });

  it('rejects archive-derived fields', () => {
    const res = validateIngestChatInput({ ...VALID, tags: ['a'], summary: 's' });
    expect(res.details).toContain('"tags" is server-owned and must not be sent');
    expect(res.details).toContain('"summary" is server-owned and must not be sent');
  });

  it('rejects unknown fields', () => {
    const res = validateIngestChatInput({ ...VALID, wat: 1 });
    expect(res.details).toContain('unknown field "wat"');
  });

  it('rejects a bad occurredAt', () => {
    const res = validateIngestChatInput({ content: 'x', occurredAt: 'not-a-time' });
    expect(res.details!.some((d) => d.startsWith('"occurredAt"'))).toBe(true);
  });

  it('rejects non-object bodies', () => {
    expect(validateIngestChatInput(null).error).toBe('body must be a JSON object');
    expect(validateIngestChatInput([VALID]).error).toBe('body must be a JSON object');
  });
});

describe('normalizeIngestChat', () => {
  it('builds an archive item and the Foundation payload from the raw fields', () => {
    const { item, urlKey, foundationPayload } = normalizeIngestChat(VALID, 'id-1', 12345);
    expect(item.id).toBe('id-1');
    expect(item.type).toBe('chat');
    expect(item.source).toBe('Claude');
    expect(item.title).toBe('Test conversation');
    expect(item.capture.sourceProvider).toBe('claude');
    expect(item.capture.url).toBe('https://claude.ai/chat/abc-123');
    expect(item.capture.occurredAt).toBe('2025-10-09T08:53:20.000Z');
    expect(item.capture.turns).toEqual(VALID.turns);
    // The archive date is the conversation's own moment, not the ingest time.
    expect(item.createdAt).toBe(1760000000000);
    expect(item.updatedAt).toBe(1760000000000);
    expect(item.foundation).toEqual({ status: 'pending', at: 12345 });
    expect(typeof item.contentHash).toBe('string');
    expect(urlKey).toBe('https://claude.ai/chat/abc-123');
    expect(foundationPayload.source).toBe('chronicle-capture');
    expect(foundationPayload.content).toBe(VALID.content);
    expect(foundationPayload.turns).toEqual(VALID.turns);
    expect(foundationPayload.occurredAt).toBe('2025-10-09T08:53:20.000Z');
  });

  it('never carries a server-owned field on the Foundation payload', () => {
    const { foundationPayload } = normalizeIngestChat(VALID, 'id-1');
    const forbidden = ['status', 'providerConversationId', 'contentHash', 'id', 'ingestedAt', 'objectType', 'tags', 'summary'];
    for (const key of Object.keys(foundationPayload)) {
      expect(forbidden).not.toContain(key);
    }
  });

  it('derives a title from the first turn when none is given', () => {
    const { item } = normalizeIngestChat({ content: 'User: first question', sourceProvider: 'chatgpt' }, 'id-2');
    expect(item.title).toBe('User: first question');
    expect(item.source).toBe('ChatGPT');
  });

  it('accepts epoch-seconds occurredAt', () => {
    const { item } = normalizeIngestChat({ content: 'x', occurredAt: 1760000000 }, 'id-3');
    expect(item.capture.occurredAt).toBe('2025-10-09T08:53:20.000Z');
  });

  it('falls back to the ingest time when the source carries no timestamp', () => {
    const { item } = normalizeIngestChat({ content: 'x' }, 'id-5', 999);
    expect(item.createdAt).toBe(999);
    expect(item.updatedAt).toBe(999);
  });

  it('keeps unknown roles on the assistant side, like the existing importers', () => {
    const { item } = normalizeIngestChat(
      { content: 'x', turns: [{ role: 'tool', text: 't' }, { role: 'human', text: 'h' }] },
      'id-4'
    );
    expect(item.capture.turns).toEqual([
      { role: 'assistant', text: 't' },
      { role: 'user', text: 'h' },
    ]);
  });
});

describe('archiveTimestamps', () => {
  it('uses the conversation moment from capture.occurredAt', () => {
    const { createdAt, updatedAt } = archiveTimestamps({ occurredAt: '2025-10-09T08:53:20.000Z' }, 12345);
    expect(createdAt).toBe(1760000000000);
    expect(updatedAt).toBe(1760000000000);
  });

  it('falls back when there is no capture or no occurredAt', () => {
    expect(archiveTimestamps(undefined, 12345)).toEqual({ createdAt: 12345, updatedAt: 12345 });
    expect(archiveTimestamps({}, 12345)).toEqual({ createdAt: 12345, updatedAt: 12345 });
    expect(archiveTimestamps({ occurredAt: 'not-a-time' }, 12345)).toEqual({ createdAt: 12345, updatedAt: 12345 });
  });
});

describe('findExistingRow', () => {
  const content = 'User: hi';
  const hash = normalizeIngestChat({ content }, 'x').item.contentHash;

  it('matches by normalized URL first', () => {
    const rows = [
      { id: 'a', content: 'other', capture: { url: 'https://claude.ai/chat/abc?foo=1' } },
      { id: 'b', content: 'other' },
    ];
    expect(findExistingRow(rows, 'https://claude.ai/chat/abc', hash)?.id).toBe('a');
  });

  it('falls back to the content hash', () => {
    expect(findExistingRow([{ id: 'b', content }], null, hash)?.id).toBe('b');
  });

  it('returns null when nothing matches', () => {
    expect(findExistingRow([{ id: 'b', content: 'different' }], null, hash)).toBeNull();
  });
});

describe('toSourceType', () => {
  it('maps known providers onto Chronicle display sources', () => {
    expect(toSourceType('chatgpt')).toBe('ChatGPT');
    expect(toSourceType('claude')).toBe('Claude');
    expect(toSourceType('gemini')).toBe('Gemini');
    expect(toSourceType('qwen')).toBe('Qwen');
    expect(toSourceType('local')).toBe('Local LLM');
  });

  it('falls back to Other', () => {
    expect(toSourceType('something-else')).toBe('Other');
    expect(toSourceType(undefined)).toBe('Other');
  });
});

describe('attachments', () => {
  const IMAGE = {
    id: 'att-1',
    filename: 'foto.png',
    mimeType: 'image/png',
    size: 2048,
    url: '/api/attachments/att-1/foto.png',
    hash: 'a'.repeat(64),
    localUrl: `chronicle-asset://blob/${'a'.repeat(64)}`,
  };
  const PDF = {
    id: 'att-2',
    filename: 'rapport.pdf',
    mimeType: 'application/pdf',
    size: 90000,
    url: '/api/attachments/att-2/rapport.pdf',
    hash: 'b'.repeat(64),
    localUrl: `chronicle-asset://blob/${'b'.repeat(64)}`,
  };

  it('accepts attachment references and gaps', () => {
    expect(validateIngestChatInput({ ...VALID, attachments: [IMAGE], attachmentGaps: [{ filename: 'x.pdf', reason: 'te groot' }] })).toEqual({});
  });

  it('requires an id on every attachment', () => {
    const res = validateIngestChatInput({ ...VALID, attachments: [{ filename: 'zonder-id.pdf' }] });
    expect(res.error).toBe('invalid ingest payload');
    expect(res.details).toContain('"attachments[0].id" is required (the Foundation attachment id)');
  });

  it('requires a reason on every gap', () => {
    const res = validateIngestChatInput({ ...VALID, attachmentGaps: [{ filename: 'x.pdf' }] });
    expect(res.details).toContain('"attachmentGaps[0].reason" is required');
  });

  it('forwards attachments to Foundation without archive-only fields', () => {
    const { foundationPayload, item } = normalizeIngestChat({ ...VALID, attachments: [IMAGE, PDF] }, 'row-1');
    expect(foundationPayload.attachments).toEqual([
      { id: 'att-1', filename: 'foto.png', mimeType: 'image/png', size: 2048, url: '/api/attachments/att-1/foto.png' },
      { id: 'att-2', filename: 'rapport.pdf', mimeType: 'application/pdf', size: 90000, url: '/api/attachments/att-2/rapport.pdf' },
    ]);
    // hash/localUrl stay in the archive: they describe chronicle-asset URLs
    // that mean nothing to Foundation.
    expect(foundationPayload.attachments?.[0]).not.toHaveProperty('hash');
    expect(item.capture.attachments?.[0]).toMatchObject({ hash: IMAGE.hash, localUrl: IMAGE.localUrl });
  });

  it('keeps gaps in the archive and out of the Foundation payload', () => {
    const { foundationPayload, item } = normalizeIngestChat(
      { ...VALID, attachments: [PDF], attachmentGaps: [{ filename: 'groot.pdf', mimeType: 'application/pdf', reason: 'groter dan 25 MB' }] },
      'row-1'
    );
    expect(foundationPayload.attachments).toHaveLength(1);
    expect(foundationPayload).not.toHaveProperty('attachmentGaps');
    expect(item.capture.attachmentGaps).toEqual([
      { filename: 'groot.pdf', mimeType: 'application/pdf', reason: 'groter dan 25 MB' },
    ]);
  });

  it('renders image attachments through the local mirror, not files', () => {
    const { item } = normalizeIngestChat({ ...VALID, attachments: [IMAGE, PDF] }, 'row-1');
    expect(item.assets).toEqual([IMAGE.localUrl]);
  });

  it('omits assets when only non-images were captured', () => {
    const { item } = normalizeIngestChat({ ...VALID, attachments: [PDF] }, 'row-1');
    expect(item.assets).toBeUndefined();
  });

  it('drops malformed entries instead of half-storing them', () => {
    const { item } = normalizeIngestChat(
      { ...VALID, attachments: [{ id: 'ok' }, { id: '' }, { filename: 'geen-id' }] },
      'row-1'
    );
    expect(item.capture.attachments).toEqual([{ id: 'ok' }]);
  });
});
