import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Regressietest voor de tekstextractie van de provider-scripts.
 *
 * De helper is een browser-IIFE (MV3 content script) die zich aan
 * `window.__chronicleUI` hangt; we laden hem hier als tekst, zodat er geen
 * ES-module van gemaakt hoeft te worden. `chrome.*` bestaat niet in jsdom — de
 * helper vangt dat zelf af.
 *
 * Let op: jsdom kent `innerText` niet, dus `innerTextWithCodeFences` valt hier
 * terug op `textContent`. Wat deze test dus níet dekt is het omzetten van
 * blokgrenzen naar newlines (dat is echte innerText en is met Chromium
 * geverifieerd); de rest van het gedrag — a11y-labels eruit en codeblokken naar
 * markdown-fences — loopt hier wél door dezelfde code.
 */
const source = readFileSync(path.join(process.cwd(), 'plugin', 'content', 'normalize.js'), 'utf8');

const ui = () => (window as any).__chronicleUI as { innerTextWithCodeFences: (node: Node) => string };

beforeAll(() => {
  new Function(source)();
});

/** De markup van één Gemini-gebruikersbeurt (2026): het label bevat de héle prompt. */
function geminiQueryText(inner: string) {
  const wrap = document.createElement('div');
  wrap.className = 'query-text gds-body-l';
  wrap.innerHTML =
    '<h5 class="cdk-visually-hidden screen-reader-user-query-label"><span>You said</span> Ja</h5>' +
    '<p class="query-text-line ng-star-inserted">' +
    inner +
    '</p>';
  document.body.appendChild(wrap);
  return wrap;
}

describe('innerTextWithCodeFences', () => {
  it('laat het schermlezer-label weg zodat de beurt niet dubbel staat', () => {
    const text = ui().innerTextWithCodeFences(geminiQueryText(' Ja '));
    expect(text).not.toMatch(/you said/i);
    expect(text.trim()).toBe('Ja');
  });

  it('zet codeblokken om naar markdown-fences met de taal erbij', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p>kijk:</p><pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>';
    document.body.appendChild(wrap);
    const text = ui().innerTextWithCodeFences(wrap);
    expect(text).toContain('```js');
    expect(text).toContain('const a = 1;');
    expect(text).toContain('```');
  });

  it('laat de renderhost niet in de pagina achter', () => {
    const wrap = geminiQueryText('Ja');
    ui().innerTextWithCodeFences(wrap);
    const hosts = [...document.body.children].filter(
      (el) => (el as HTMLElement).style.left === '-99999px'
    );
    expect(hosts).toHaveLength(0);
    expect(document.body.contains(wrap)).toBe(true);
  });
});

describe('attachments in buildConversation', () => {
  const uiFull = () => (window as any).__chronicleUI;

  it('laat lege bijlagelijsten weg (payloadvorm blijft gelijk)', () => {
    const conv = uiFull().buildConversation({
      content: 'User: hi',
      turns: [{ role: 'user', text: 'hi' }],
      sourceProvider: 'claude',
      attachments: [],
      attachmentGaps: [],
    });
    expect(conv).not.toHaveProperty('attachments');
    expect(conv).not.toHaveProperty('attachmentGaps');
  });

  it('draagt referenties en gaps mee', () => {
    const conv = uiFull().buildConversation({
      content: 'User: hi',
      turns: [{ role: 'user', text: 'hi' }],
      sourceProvider: 'chatgpt',
      attachments: [{ providerFileId: 'file-1', download: 'chatgpt', filename: 'a.pdf' }],
      attachmentGaps: [{ filename: 'b.pdf', reason: 'groter dan 25 MB' }],
    });
    expect(conv.attachments).toEqual([{ providerFileId: 'file-1', download: 'chatgpt', filename: 'a.pdf' }]);
    expect(conv.attachmentGaps).toEqual([{ filename: 'b.pdf', reason: 'groter dan 25 MB' }]);
  });

  it('attachmentRef laat lege velden weg', () => {
    expect(uiFull().attachmentRef({ providerFileId: 'x', filename: '', size: null })).toEqual({ providerFileId: 'x' });
  });

  it('leidt een extensie en mime-type af', () => {
    expect(uiFull().extensionForMime('application/pdf')).toBe('pdf');
    expect(uiFull().mimeFromFilename('rapport.PDF')).toBe('application/pdf');
    expect(uiFull().mimeFromFilename('raar.xyz')).toBe('application/octet-stream');
  });
});

describe('transcriptFromTurns met bijlagen', () => {
  const transcript = () => (window as any).__chronicleUI.transcriptFromTurns as (
    turns: Array<{ role: string; text: string }>,
    attachments?: Array<Record<string, unknown>>
  ) => string;

  const turns = [
    { role: 'user', text: 'maak een foto van een kat' },
    { role: 'assistant', text: 'hier is hij' },
    { role: 'user', text: 'mooi' },
  ];

  it('laat de tekst ongemoeid zonder bijlagen', () => {
    expect(transcript()(turns)).toBe(
      'User: maak een foto van een kat\n\nAssistant: hier is hij\n\nUser: mooi'
    );
  });

  it('zet de marker achter de beurt waarin de foto ontstond', () => {
    const out = transcript()(turns, [
      { filename: 'Winterkat', afterTurn: 2 },
    ]);
    expect(out).toBe(
      'User: maak een foto van een kat\n\nAssistant: hier is hij\n\n[Bijlage: Winterkat]\n\nUser: mooi'
    );
  });

  it('negeert bijlagen zonder positie of zonder naam', () => {
    const out = transcript()(turns, [
      { filename: 'zonder-positie' },
      { afterTurn: 1 },
    ]);
    expect(out).not.toContain('[Bijlage:');
  });
});
