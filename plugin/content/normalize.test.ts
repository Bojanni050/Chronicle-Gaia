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
