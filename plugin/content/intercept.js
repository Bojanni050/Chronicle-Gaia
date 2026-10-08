/**
 * Automatische capture — MAIN world interceptor.
 *
 * Dit script draait in de pagina zelf (world: MAIN, document_start) en wikkelt
 * window.fetch en XMLHttpRequest in. Het enige wat het doet: signaleren dát
 * een gesprek net is bijgewerkt. Geen parsing van response-inhoud — de
 * interne API-vormen wijzigen regelmatig, en een signaal ("conversation X
 * heeft een nieuw antwoord") overleeft dat. Het content script (isolated
 * world) haalt het gesprek daarna op via de normale, bewezen API-route en
 * levert het af via de service worker. Herlevering is veilig: de listener
 * dedupt op url/contentHash, dus dit is idempotent.
 *
 * Signalen (altijd pas nadat de respons volledig is uitgelezen — clone().
 * arrayBuffer() resolveert als de stream klaar is — zodat het gesprek al
 * is gegroeid bij levering):
 *  - Claude: POST /chat_conversations/{uuid}/completion en /retry_completion
 *  - ChatGPT: POST /backend-api/conversation (exact — niet de
 *    /conversation/{id}/...-subroutes voor titelbewerkingen e.d.)
 */
(() => {
  if (window.__chronicleInterceptInstalled) return;
  window.__chronicleInterceptInstalled = true;

  /** fetch(url) kent drie vormen: string, URL-object en Request. */
  function requestUrl(args) {
    const target = args[0];
    if (typeof target === 'string') return target;
    if (target && typeof target.href === 'string') return target.href; // URL
    if (target && typeof target.url === 'string') return target.url; // Request
    return '';
  }

  function requestMethod(args) {
    if (args[1] && typeof args[1].method === 'string') return args[1].method;
    const target = args[0];
    if (target && typeof target.method === 'string') return target.method; // Request
    return 'GET';
  }

  const CLAUDE_COMPLETION = /\/chat_conversations\/([0-9a-f-]{36})\/(completion|retry_completion)/;
  const CHATGPT_CONVERSATION = /\/backend-api\/conversation\/?(\?|$)/;

  function signal(provider, uuid) {
    console.info('[Chronicle] intercept:', provider, uuid || '');
    window.postMessage(
      {
        source: 'chronicle-intercept',
        type: 'conversation-updated',
        provider,
        ...(uuid ? { uuid } : {}),
      },
      location.origin
    );
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    try {
      const url = requestUrl(args);
      const method = requestMethod(args);
      if (!/post/i.test(method)) return res;

      const claudeMatch = url.match(CLAUDE_COMPLETION);
      if (claudeMatch) {
        res
          .clone()
          .arrayBuffer()
          .then(() => signal('claude', claudeMatch[1]))
          .catch(() => {});
        return res;
      }

      if (CHATGPT_CONVERSATION.test(url)) {
        res
          .clone()
          .arrayBuffer()
          .then(() => signal('chatgpt'))
          .catch(() => {});
        return res;
      }
    } catch {
      // interceptie mag de pagina nooit breken
    }
    return res;
  };

  // Legacy-modus van claude.ai kan de completion ook via XHR draaien;
  // dezelfde signaalregels op de XHR-kant (loadend = overdracht klaar).
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
    if (!/post/i.test(method)) return origSend.apply(this, args);
    const claudeMatch = url.match(CLAUDE_COMPLETION);
    const isChatgpt = CHATGPT_CONVERSATION.test(url);
    if (claudeMatch || isChatgpt) {
      this.addEventListener('loadend', () => {
        signal(isChatgpt && !claudeMatch ? 'chatgpt' : 'claude', claudeMatch ? claudeMatch[1] : undefined);
      });
    }
    return origSend.apply(this, args);
  };
  console.info('[Chronicle] auto-capture interceptor actief op', location.host);
})();
