
import { describe, it, expect } from 'vitest';
import {
  parseClaudeConversation,
  parseClaudeExport,
  parseChatGPTConversation,
  parseConversationJson,
  parseMarkdownTranscript,
  looksLikeMarkdownExport,
} from './sourceParsers';

describe('parseClaudeConversation', () => {
  const conv = {
    uuid: 'd9b2f1e0-1111-2222-3333-444455556666',
    name: 'Migraties bespreken',
    created_at: '2026-03-01T10:00:00.000Z',
    updated_at: '2026-03-02T12:00:00.000Z',
    chat_messages: [
      { sender: 'human', text: 'Wat is een migratie?' },
      { sender: 'assistant', content: [{ type: 'text', text: 'Een migratie is ...' }] },
      { sender: 'assistant', content: [{ type: 'thinking', thinking: 'intern' }] },
    ],
  };

  it('maps sender to user/assistant and derives the claude url', () => {
    const parsed = parseClaudeConversation(conv)!;
    expect(parsed.sourceProvider).toBe('claude');
    expect(parsed.url).toBe('https://claude.ai/chat/d9b2f1e0-1111-2222-3333-444455556666');
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'Wat is een migratie?' },
      { role: 'assistant', text: 'Een migratie is ...' },
    ]);
    expect(parsed.title).toBe('Migraties bespreken');
  });

  it('parses timestamps and uses updated_at as occurredAt', () => {
    const parsed = parseClaudeConversation(conv)!;
    expect(parsed.createdAt).toBe(Date.parse('2026-03-01T10:00:00.000Z'));
    expect(parsed.occurredAt).toBe(Date.parse('2026-03-02T12:00:00.000Z'));
  });

  it('skips non-text content blocks (thinking) without inventing turns', () => {
    const parsed = parseClaudeConversation(conv)!;
    expect(parsed.turns).toHaveLength(2);
  });

  it('returns null for an empty conversation', () => {
    expect(parseClaudeConversation({ uuid: 'x', chat_messages: [] })).toBeNull();
  });

  it('parses an array container of conversations', () => {
    const all = parseClaudeExport([conv, { uuid: 'empty', chat_messages: [] }]);
    expect(all).toHaveLength(1);
    expect(all[0].url).toContain('d9b2f1e0');
  });
});

describe('parseChatGPTConversation (mapping tree)', () => {
  // root -> user -> assistant, plus a hidden system node.
  const mapping = {
    root: { id: 'root', parent: null, children: ['sys', 'u1'], message: null },
    sys: { id: 'sys', parent: 'root', children: [], message: { author: { role: 'system' }, content: { parts: ['You are ChatGPT'] } } },
    u1: { id: 'u1', parent: 'root', children: ['a1'], message: { author: { role: 'user' }, content: { parts: ['Hoe werkt dit?'] }, create_time: 1772532000 } },
    a1: { id: 'a1', parent: 'u1', children: [], message: { author: { role: 'assistant' }, content: { parts: ['Zo dus.'] } } },
  };
  const root = {
    title: 'Een ChatGPT gesprek',
    create_time: 1772532000,
    update_time: 1772535600,
    mapping,
  };

  it('walks the tree in order and maps roles', () => {
    const parsed = parseChatGPTConversation(root)!;
    expect(parsed.sourceProvider).toBe('chatgpt');
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'Hoe werkt dit?' },
      { role: 'assistant', text: 'Zo dus.' },
    ]);
  });

  it('skips the hidden system message', () => {
    const parsed = parseChatGPTConversation(root)!;
    expect(parsed.turns.some((t) => t.text.includes('ChatGPT'))).toBe(false);
  });

  it('converts unix seconds to ms for createdAt/occurredAt', () => {
    const parsed = parseChatGPTConversation(root)!;
    expect(parsed.createdAt).toBe(1772532000000);
    expect(parsed.occurredAt).toBe(1772535600000);
  });

  it('has no url (the export does not contain one)', () => {
    expect(parseChatGPTConversation(root)!.url).toBeUndefined();
  });

  it('extracts images from message parts, keeping data URLs and pointers', () => {
    const withImages = {
      title: 'Beeld',
      mapping: {
        u: {
          id: 'u', parent: null, children: [],
          message: {
            author: { role: 'user' },
            content: {
              parts: [
                'kijk hier',
                { content_type: 'image_asset_pointer', asset_pointer: 'data:image/png;base64,AAAA' },
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc', metadata: { file_name: 'foto.png' } },
                { unrelated: true },
              ],
            },
          },
        },
      },
    };
    const parsed = parseChatGPTConversation(withImages)!;
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images![0].dataUrl).toBe('data:image/png;base64,AAAA');
    expect(parsed.images![0].mimeType).toBe('image/png');
    expect(parsed.images![1].sourceUrl).toBe('file-service://file-abc');
    expect(parsed.images![1].filename).toBe('foto.png');
  });

  it('omits the images key when a conversation has none', () => {
    expect(parseChatGPTConversation(root)!.images).toBeUndefined();
  });

  it('does not loop on a cyclic parent reference', () => {
    const cyclic = {
      title: 'Cycle',
      mapping: {
        a: { id: 'a', parent: 'b', children: ['b'], message: { author: { role: 'user' }, content: { parts: ['hoi'] } } },
        b: { id: 'b', parent: 'a', children: ['a'], message: { author: { role: 'assistant' }, content: { parts: ['dag'] } } },
      },
    };
    // No node is a root here (a→b→a), so nothing is reachable; the point is
    // that the walk terminates instead of spinning forever.
    const parsed = parseChatGPTConversation(cyclic);
    expect(parsed).toBeNull();
  });

  it('does not revisit a node reachable by two parents', () => {
    const diamond = {
      title: 'Diamond',
      mapping: {
        root: { id: 'root', parent: null, children: ['u', 'a'] },
        u: { id: 'u', parent: 'root', children: ['a'], message: { author: { role: 'user' }, content: { parts: ['vraag'] } } },
        a: { id: 'a', parent: 'root', children: [], message: { author: { role: 'assistant' }, content: { parts: ['antwoord'] } } },
      },
    };
    const parsed = parseChatGPTConversation(diamond)!;
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'vraag' },
      { role: 'assistant', text: 'antwoord' },
    ]);
  });
});

describe('parseMarkdownTranscript (third-party exporter)', () => {
  const exportMd = `> From: https://chatgpt.com/g/g-p-6a73314f25a0819183abf95e1617d71b-gaia/c/6ac2ea61-4fb0-83ed-b8da-f94a267d25c8

# you asked

message time: 2026-10-05 02:08:07

Hindsight werkt met geïsoleerde banken.

---

# chatgpt response

Ja. Dat is architectonisch netjes.
`;

  it('recognises the export shape', () => {
    expect(looksLikeMarkdownExport(exportMd)).toBe(true);
    expect(looksLikeMarkdownExport('User: hoi\n\nAssistant: hallo')).toBe(false);
  });

  it('splits speakers into user/assistant turns', () => {
    const parsed = parseMarkdownTranscript(exportMd)!;
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'Hindsight werkt met geïsoleerde banken.' },
      { role: 'assistant', text: 'Ja. Dat is architectonisch netjes.' },
    ]);
  });

  it('extracts the conversation url and derives the provider', () => {
    const parsed = parseMarkdownTranscript(exportMd)!;
    expect(parsed.url).toBe('https://chatgpt.com/g/g-p-6a73314f25a0819183abf95e1617d71b-gaia/c/6ac2ea61-4fb0-83ed-b8da-f94a267d25c8');
    expect(parsed.sourceProvider).toBe('chatgpt');
  });

  it('parses the message time as occurredAt (not as message text)', () => {
    const parsed = parseMarkdownTranscript(exportMd)!;
    expect(parsed.occurredAt).toBe(Date.parse('2026-10-05 02:08:07'));
    expect(parsed.turns[0].text).not.toContain('message time');
  });

  it('handles claude and gemini headings too', () => {
    const claudeMd = `> From: https://claude.ai/chat/abc\n\n# human\n\nhoi\n\n---\n\n# claude\n\ndag\n`;
    const parsed = parseMarkdownTranscript(claudeMd)!;
    expect(parsed.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(parsed.sourceProvider).toBe('claude');
  });

  it('returns null when the shape is absent', () => {
    expect(parseMarkdownTranscript('just some text')).toBeNull();
  });
});

describe('parseConversationJson dispatcher', () => {
  it('detects a mapping tree as ChatGPT', () => {
    const parsed = parseConversationJson({
      title: 't',
      mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { parts: ['x'] } } } },
    })!;
    expect(parsed.sourceProvider).toBe('chatgpt');
  });

  it('parses a messages container as generic', () => {
    const parsed = parseConversationJson({
      title: 'Note',
      messages: [
        { role: 'user', content: 'vraag' },
        { role: 'assistant', content: 'antwoord' },
      ],
    })!;
    expect(parsed.sourceProvider).toBe('other');
    expect(parsed.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('falls back to a single Claude conversation', () => {
    const parsed = parseConversationJson({
      uuid: 'abc-123',
      chat_messages: [{ sender: 'human', text: 'hoi' }],
    })!;
    expect(parsed.sourceProvider).toBe('claude');
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseConversationJson({})).toBeNull();
  });

  it('parses a contents[]-block export with a chatGroupId (third-party JSON)', () => {
    const exportJson = [
      {
        id: 'm1', role: 'user', chatGroupId: '6ac2ea61-4fb0-83ed-b8da-f94a267d25c8',
        contents: [{ type: 'text', content: 'vraag' }], created_at: '2026-10-05 02:08:07',
      },
      {
        id: 'm2', role: 'assistant', chatGroupId: '6ac2ea61-4fb0-83ed-b8da-f94a267d25c8',
        contents: [{ type: 'text', content: 'antwoord' }, { type: 'image', content: 'ignored' }],
        created_at: '2026-10-05 02:08:18',
      },
    ];
    const parsed = parseConversationJson(exportJson)!;
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'vraag' },
      { role: 'assistant', text: 'antwoord' },
    ]);
    expect(parsed.url).toBe('https://chatgpt.com/c/6ac2ea61-4fb0-83ed-b8da-f94a267d25c8');
    expect(parsed.sourceProvider).toBe('chatgpt');
  });
});
