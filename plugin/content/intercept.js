/**
 * Automatische capture — MAIN world interceptor.
 *
 * Dit script draait in de pagina zelf (world: MAIN, document_start) en wikkelt
 * window.fetch in. Het enige wat het doet: signaleren dát een gesprek net is
 * bijgewerkt. Geen parsing van response-inhoud — de interne API-vormen
 * wijzigen regelmatig, en een signaal ("conversation X heeft een nieuw
 * antwoord") overleeft dat. Het content script (isolated world) haalt het
 * gesprek daarna op via de normale, bewezen API-route en levert het af via
 * de service worker. Herlevering is veilig: de listener dedupt op
 * url/contentHash, dus dit is idempotent.
 *
 * Signalen:
 *  - Claude: POST /chat_conversations/{uuid}/completion — het signaal gaat
 *    pas af nadat de stream volledig is uitgelezen (clone().arrayBuffer()
 *    resolveert dan), zodat het gesprek al groeit bij levering.
 *  - ChatGPT: POST /backend-api/conversation — het signaal na afloop; de
 *    content script-kant gebruikt de id uit de paginanavigatie.
 */
(() => {
  if (window.__chronicleInterceptInstalled) return;
  window.__chronicleInterceptInstalled = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';

      const claudeMatch = url.match(/\/chat_conversations\/([0-9a-f-]{36})\/completion/);
      if (claudeMatch && /post/i.test(method)) {
        console.info('[Chronicle] intercept (fetch):', url.slice(0, 80));
        // Background: resolveert als de stream klaar is. De caller krijgt res
        // direct terug — de app moet zelf kunnen streamen lezen.
        res
          .clone()
          .arrayBuffer()
          .then(() => {
            window.postMessage(
              { source: 'chronicle-intercept', type: 'conversation-updated', provider: 'claude', uuid: claudeMatch[1] },
              location.origin
            );
          })
          .catch(() => {});
        return res;
      }

      if (/post/i.test(method) && /\/backend-api\/conversation(\/|$|\?)/.test(url)) {
        window.postMessage(
          { source: 'chronicle-intercept', type: 'conversation-updated', provider: 'chatgpt' },
          location.origin
        );
        return res;
      }
    } catch {
      // interceptie mag de pagina nooit breken
    }
    return res;
  };
  // Legacy-modus van claude.ai kan de completion ook via XHR draaien in
  // plaats van fetch; dezelfde signaalregel op de XHR-kant.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__chronicleUrl = String(url || '');
    this.__chronicleMethod = String(method || 'GET');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__chronicleUrl || '';
    const method = this.__chronicleMethod || '';
    const claudeMatch = url.match(/\/chat_conversations\/([0-9a-f-]{36})\/completion/);
    const chatgptMatch = /post/i.test(method) && /\/backend-api\/conversation(\/|$|\?)/.test(url);
    if ((claudeMatch && /post/i.test(method)) || chatgptMatch) {
      this.addEventListener('loadend', () => {
        console.info('[Chronicle] intercept (XHR):', url.slice(0, 80));
        window.postMessage(
          {
            source: 'chronicle-intercept',
            type: 'conversation-updated',
            provider: chatgptMatch ? 'chatgpt' : 'claude',
            ...(claudeMatch && !chatgptMatch ? { uuid: claudeMatch[1] } : {}),
          },
          location.origin
        );
      });
    }
    return origSend.apply(this, args);
  };
  console.info('[Chronicle] auto-capture interceptor actief op', location.host);
})();
