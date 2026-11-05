import { SourceType } from '../types';

/**
 * The browser clipper sends every clip as `sourceProvider: 'web'` with the
 * page URL on the capture. Rendering that as "Web" for each one hides where a
 * note actually came from, so anything web-sourced shows its site instead.
 *
 * Since a web object stores its page URL as `source`, the source itself may
 * already be a URL: that is the strongest signal, and it also covers clips
 * ingested before the object type existed.
 *
 * Derived at render time rather than stored: older clips already have the URL
 * on the capture, and Foundation keeps its own `web` source type — sending a
 * hostname as the provider would only break that contract.
 */
export function siteNameFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host || null;
  } catch {
    return null;
  }
}

export function displaySource(source: string, url?: string | null): string {
  // A web object's source is the page URL itself.
  const fromSource = siteNameFromUrl(source);
  if (fromSource) return fromSource;
  if (source !== SourceType.WEB) return source;
  return siteNameFromUrl(url) || source;
}
