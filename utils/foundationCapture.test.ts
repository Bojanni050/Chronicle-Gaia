
import { describe, it, expect } from 'vitest';
import {
  buildChatIngestPayload,
  toFoundationRole,
  toSourceProvider,
  CHRONICLE_CAPTURE_SOURCE,
} from './foundationCapture';

const ALLOWED_KEYS = ['content', 'source', 'title', 'sourceProvider', 'url', 'occurredAt', 'turns'];
const FORBIDDEN_KEYS = [
  'status',
  'providerConversationId',
  'contentHash',
  'id',
  'ingestedAt',
  'updatedAt',
  'objectType',
  'tags',
  'summary',
  'embedding',
  'assets',
];

describe('buildChatIngestPayload', () => {
  it('emits only contract-allowed keys', () => {
    const payload = buildChatIngestPayload({
      content: 'User: hoi\n\nAssistant: hallo',
      title: 'Een gesprek',
      sourceProvider: 'chatgpt',
      url: 'https://chatgpt.com/c/6198b802-abcd-1234-5678',
      occurredAt: '2026-10-04T12:00:00.000Z',
      turns: [
        { role: 'user', text: 'hoi' },
        { role: 'assistant', text: 'hallo' },
      ],
    });

    for (const key of Object.keys(payload)) {
      expect(ALLOWED_KEYS).toContain(key);
    }
    expect(payload.source).toBe(CHRONICLE_CAPTURE_SOURCE);
    expect(payload.content).toBe('User: hoi\n\nAssistant: hallo');
    expect(payload.providerConversationId).toBeUndefined();
  });

  it('never carries server-owned or derived fields, even when handed them', () => {
    const withExtras = {
      content: 'x',
      status: 'confirmed',
      providerConversationId: 'forged',
      contentHash: 'forged',
      id: 'forged',
      objectType: 'chat',
      tags: ['derived'],
      summary: 'derived',
      embedding: [0.1, 0.2],
      assets: ['data:image/png;base64,zzz'],
    };
    // The caller is not supposed to pass these; cast because the type forbids them.
    const payload = buildChatIngestPayload(withExtras as any);

    for (const key of FORBIDDEN_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(Object.keys(payload).sort()).toEqual(['content', 'source']);
  });

  it('requires a non-empty content', () => {
    expect(() => buildChatIngestPayload({ content: '' })).toThrow();
    expect(() => buildChatIngestPayload({ content: '   ' })).toThrow();
    expect(() => buildChatIngestPayload(undefined as any)).toThrow();
  });

  it('omits empty optional fields instead of sending blanks', () => {
    const payload = buildChatIngestPayload({ content: 'x', title: '  ', url: '' });
    expect(payload.title).toBeUndefined();
    expect(payload.url).toBeUndefined();
    expect(payload.turns).toBeUndefined();
  });

  it('normalizes turns to user/assistant and drops empty text', () => {
    const payload = buildChatIngestPayload({
      content: 'x',
      turns: [
        { role: 'user', text: 'vraag' },
        { role: 'model', text: 'antwoord' },
        { role: 'system', text: 'context' },
        { role: 'assistant', text: '   ' },
      ],
    });
    expect(payload.turns).toEqual([
      { role: 'user', text: 'vraag' },
      { role: 'assistant', text: 'antwoord' },
      { role: 'assistant', text: 'context' },
    ]);
  });

  it('rejects an occurredAt that is not a parseable ISO timestamp', () => {
    expect(() => buildChatIngestPayload({ content: 'x', occurredAt: 'gisteren' })).toThrow();
  });

  it('keeps a valid ISO timestamp', () => {
    const iso = '2026-10-04T12:00:00.000Z';
    expect(buildChatIngestPayload({ content: 'x', occurredAt: iso }).occurredAt).toBe(iso);
  });
});

describe('toFoundationRole', () => {
  it('maps the human side to user', () => {
    expect(toFoundationRole('user')).toBe('user');
    expect(toFoundationRole('Human')).toBe('user');
    expect(toFoundationRole('You')).toBe('user');
  });

  it('maps model/assistant/system and unknown roles to assistant', () => {
    expect(toFoundationRole('model')).toBe('assistant');
    expect(toFoundationRole('assistant')).toBe('assistant');
    expect(toFoundationRole('system')).toBe('assistant');
    expect(toFoundationRole(undefined)).toBe('assistant');
  });
});

describe('toSourceProvider', () => {
  it('maps Chronicle source labels to lowercase provider names', () => {
    expect(toSourceProvider('ChatGPT')).toBe('chatgpt');
    expect(toSourceProvider('Claude')).toBe('claude');
    expect(toSourceProvider('Gemini')).toBe('gemini');
    expect(toSourceProvider('Local LLM')).toBe('local');
    expect(toSourceProvider('Other')).toBe('other');
  });

  it('falls back to a slug for unknown labels and undefined for blank', () => {
    expect(toSourceProvider('My Cool Bot')).toBe('my-cool-bot');
    expect(toSourceProvider('')).toBeUndefined();
    expect(toSourceProvider(undefined)).toBeUndefined();
  });
});
