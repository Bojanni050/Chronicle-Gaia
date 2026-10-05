
import { describe, it, expect } from 'vitest';
import { foundationContentHash, normalizeUrl, dedupKeys, findChatDuplicate } from './chatDedup';

describe('foundationContentHash', () => {
  it('matches Foundation\'s algorithm (portable identity)', () => {
    // Same function as server/contentHash.js — a known input/format.
    expect(foundationContentHash('hello')).toMatch(/^ch_[a-z0-9]+$/);
    expect(foundationContentHash('hello')).toBe(foundationContentHash('hello'));
    expect(foundationContentHash('hello')).not.toBe(foundationContentHash('world'));
  });

  it('returns empty for empty input', () => {
    expect(foundationContentHash('')).toBe('');
  });
});

describe('normalizeUrl', () => {
  it('drops query and hash, and a trailing slash', () => {
    expect(normalizeUrl('https://chatgpt.com/c/abc?foo=1#x')).toBe('https://chatgpt.com/c/abc');
    expect(normalizeUrl('https://claude.ai/chat/abc/')).toBe('https://claude.ai/chat/abc');
  });

  it('passes unparseable strings through (minus trailing slash)', () => {
    expect(normalizeUrl('not a url/')).toBe('not a url');
  });
});

describe('dedupKeys', () => {
  it('uses the url as key when present, plus a content hash', () => {
    const keys = dedupKeys({ url: 'https://chatgpt.com/c/abc?t=1', content: 'hoi' });
    expect(keys.urlKey).toBe('https://chatgpt.com/c/abc');
    expect(keys.contentHash).toBe(foundationContentHash('hoi'));
  });

  it('has no url key when the url is absent', () => {
    expect(dedupKeys({ content: 'hoi' }).urlKey).toBeNull();
  });
});

describe('findChatDuplicate', () => {
  const existing = [
    { id: 'a', url: 'https://chatgpt.com/c/abc', content: 'vraag' },
    { id: 'b', content: 'losse tekst zonder url' },
  ];

  it('returns null when nothing matches', () => {
    expect(findChatDuplicate({ url: 'https://chatgpt.com/c/xyz', content: 'anders' }, existing)).toBeNull();
  });

  it('detects an identical chat by url → duplicate (do not import)', () => {
    const hit = findChatDuplicate({ url: 'https://chatgpt.com/c/abc', content: 'vraag' }, existing)!;
    expect(hit.action).toBe('duplicate');
    expect(hit.existing.id).toBe('a');
  });

  it('matches the url even when the query string differs', () => {
    const hit = findChatDuplicate({ url: 'https://chatgpt.com/c/abc?utm=1', content: 'vraag' }, existing)!;
    expect(hit.action).toBe('duplicate');
  });

  it('detects a grown chat by url → update (content changed)', () => {
    const hit = findChatDuplicate({ url: 'https://chatgpt.com/c/abc', content: 'vraag + nog iets' }, existing)!;
    expect(hit.action).toBe('update');
    expect(hit.existing.id).toBe('a');
  });

  it('falls back to the content hash when there is no url', () => {
    const hit = findChatDuplicate({ content: 'losse tekst zonder url' }, existing)!;
    expect(hit.action).toBe('duplicate');
    expect(hit.existing.id).toBe('b');
  });

  it('does not match a url-less candidate against a url-bearing chat by content only', () => {
    // content differs → no hit at all
    expect(findChatDuplicate({ content: 'iets heel anders' }, existing)).toBeNull();
  });
});
