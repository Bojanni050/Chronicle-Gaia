import { describe, it, expect } from 'vitest';
import { displaySource, siteNameFromUrl } from './sourceLabel';

describe('siteNameFromUrl', () => {
  it('strips www and keeps the host', () => {
    expect(siteNameFromUrl('https://www.youtube.com/watch?v=abc')).toBe('youtube.com');
  });

  it('keeps subdomains other than www', () => {
    expect(siteNameFromUrl('https://docs.docker.com/get-started/')).toBe('docs.docker.com');
  });

  it('ignores ports and paths', () => {
    expect(siteNameFromUrl('http://localhost:4580/ingest/chat')).toBe('localhost');
  });

  it('returns null for missing or unparsable input', () => {
    expect(siteNameFromUrl(undefined)).toBeNull();
    expect(siteNameFromUrl('')).toBeNull();
    expect(siteNameFromUrl('not a url')).toBeNull();
  });
});

describe('displaySource', () => {
  it('shows the site for web clips', () => {
    expect(displaySource('Web', 'https://www.theguardian.com/science/2024')).toBe('theguardian.com');
  });

  it('falls back to the source when a web clip has no url', () => {
    expect(displaySource('Web')).toBe('Web');
    expect(displaySource('Web', 'nonsense')).toBe('Web');
  });

  it('never rewrites provider sources, even with a url present', () => {
    expect(displaySource('ChatGPT', 'https://chatgpt.com/c/123')).toBe('ChatGPT');
    expect(displaySource('Manual', 'https://example.com')).toBe('Manual');
  });

  it('reads the site from a web object whose source is the page url', () => {
    expect(displaySource('https://www.theguardian.com/science/2024')).toBe('theguardian.com');
  });
});
