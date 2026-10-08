import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { zipSync, strToU8 } from 'fflate';
import zip from './claudeExportZip.cjs';
import { parseClaudeExport } from './sourceParsers';

const { readJsonEntries, isClaudeExportManifest, conversationsFromZip, conversationsFromManifest } = zip;

// One conversation in Claude's export shape (what the parser expects).
const conversation = {
  uuid: 'a83d6bc3-a58e-4ba5-8603-ec104691deca',
  name: 'Creating a custom skill',
  created_at: '2025-12-24T07:38:39.628075Z',
  updated_at: '2025-12-24T07:49:31.010381Z',
  chat_messages: [
    { sender: 'human', text: 'Let us build a skill.' },
    { sender: 'assistant', content: [{ type: 'text', text: 'Sure — what should it do?' }] },
  ],
};

function writeZip(dir: string, name: string, entries: Record<string, unknown>) {
  const files: Record<string, Uint8Array> = {};
  for (const [entryName, value] of Object.entries(entries)) {
    files[entryName] = strToU8(JSON.stringify(value));
  }
  const filePath = path.join(dir, name);
  writeFileSync(filePath, Buffer.from(zipSync(files)));
  return filePath;
}

describe('claudeExportZip', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'chronicle-export-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads .json entries out of a category zip', () => {
    const zipPath = writeZip(dir, 'conversations-000.zip', { 'conversations.json': [conversation] });
    const entries = readJsonEntries(zipPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('conversations.json');
    expect(Array.isArray(entries[0].json)).toBe(true);
  });

  it('ignores non-json entries', () => {
    const zipPath = writeZip(dir, 'mixed-000.zip', { 'conversations.json': [conversation] });
    // append a binary file into the same zip
    writeFileSync(path.join(dir, 'x.bin'), Buffer.from([0, 1, 2]));
    expect(readJsonEntries(zipPath)).toHaveLength(1);
  });

  it('parses the conversations inside a single zip', () => {
    const zipPath = writeZip(dir, 'conversations-000.zip', { 'conversations.json': [conversation] });
    const parsed = conversationsFromZip(zipPath, parseClaudeExport);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('https://claude.ai/chat/a83d6bc3-a58e-4ba5-8603-ec104691deca');
    expect(parsed[0].sourceProvider).toBe('claude');
  });

  it('recognises the manifest shape only when data_files is present', () => {
    expect(isClaudeExportManifest({ data_files: [] })).toBe(true);
    expect(isClaudeExportManifest({ conversations: [] })).toBe(false);
    expect(isClaudeExportManifest([conversation])).toBe(false);
    expect(isClaudeExportManifest(null)).toBe(false);
  });

  it('resolves sibling category zips and skips non-chat categories', () => {
    writeZip(dir, 'conversations-000.zip', { 'conversations.json': [conversation] });
    writeZip(dir, 'memories-000.zip', { 'memories.json': { memories: [{ text: 'a fact' }] } });
    writeZip(dir, 'frames-000.zip', { 'frames.json': { frames: [] } });
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = {
      data_files: [
        { category: 'memories', filename: 'memories-000.zip' },
        { category: 'frames', filename: 'frames-000.zip' },
        { category: 'conversations', filename: 'conversations-000.zip' },
      ],
    };
    const { conversations, missing } = conversationsFromManifest(manifestPath, manifest, parseClaudeExport);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe('Creating a custom skill');
    expect(missing).toEqual([]);
  });

  it('reports zips the manifest references but are not downloaded', () => {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = { data_files: [{ filename: 'conversations-999.zip' }] };
    const { conversations, missing } = conversationsFromManifest(manifestPath, manifest, parseClaudeExport);
    expect(conversations).toEqual([]);
    expect(missing).toEqual(['conversations-999.zip']);
  });
});
