/**
 * Claude's data export is no longer a single conversations.json: the download
 * page hands out a manifest.json that lists several category zips
 * (conversations, design_chats, projects, memories, frames, light_metadata).
 * This module reads that shape — and a plainly extracted .zip — and yields the
 * conversations the existing parser already understands.
 *
 * Packaging only: it never interprets message content. Categories whose JSON is
 * not a conversation array (memories, frames, login data, …) simply fall through
 * the parser and contribute nothing.
 *
 * CommonJS on purpose: the Electron main process requires it directly. It stays
 * free of Electron so it can be unit-tested (utils/claudeExportZip.test.ts).
 */
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

/**
 * Every .json entry inside a zip, parsed. Directory entries, non-.json files and
 * entries that fail to parse are skipped — one bad file never breaks an import.
 */
function readJsonEntries(zipPath) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const out = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    try {
      out.push({ name, json: JSON.parse(Buffer.from(bytes).toString('utf-8')) });
    } catch {
      // extension says JSON but the bytes don't parse — skip, don't throw
    }
  }
  return out;
}

/** True for the newer multi-file export's manifest.json. */
function isClaudeExportManifest(json) {
  return !!(json && typeof json === 'object' && Array.isArray(json.data_files));
}

/**
 * Conversations inside a single zip. A category zip (e.g. conversations-000.zip)
 * and the older all-in-one export both work.
 */
function conversationsFromZip(zipPath, parseClaudeExport) {
  const conversations = [];
  for (const { json } of readJsonEntries(zipPath)) {
    conversations.push(...parseClaudeExport(json));
  }
  return conversations;
}

/**
 * Conversations for a manifest-based export. Each referenced category zip is
 * read from the manifest's own directory (the user downloads them side by side).
 * Returns the conversations plus any zips that were referenced but not found, so
 * a partial download is visible instead of silent.
 */
function conversationsFromManifest(manifestPath, manifest, parseClaudeExport) {
  const dir = path.dirname(manifestPath);
  const conversations = [];
  const missing = [];
  for (const file of (manifest && manifest.data_files) || []) {
    const zipName = file && file.filename;
    if (!zipName) continue;
    const zipPath = path.join(dir, zipName);
    if (!fs.existsSync(zipPath)) {
      missing.push(zipName);
      continue;
    }
    try {
      conversations.push(...conversationsFromZip(zipPath, parseClaudeExport));
    } catch (err) {
      missing.push(`${zipName} (${err && err.message ? err.message : 'unreadable'})`);
    }
  }
  return { conversations, missing };
}

module.exports = {
  readJsonEntries,
  isClaudeExportManifest,
  conversationsFromZip,
  conversationsFromManifest,
};
