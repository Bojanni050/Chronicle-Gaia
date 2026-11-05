import { SourceType } from '../types';

/**
 * The browser clipper sends every clip as `sourceProvider: 'web'` with the
 * page URL on the capture. Rendering that as "Web" for each one hides where a
 * note actually came from, so anything web-sourced shows its site instead.
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
  if (source !== SourceType.WEB) return source;
  return siteNameFromUrl(url) || source;
}
