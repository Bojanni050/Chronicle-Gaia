/**
 * Transpiles utils/captureIngest.ts (pure capture/dedup logic for the ingest
 * listener, tested via Vitest) into utils/captureIngest.cjs so the Electron
 * main process — CommonJS — requires the exact same implementation instead
 * of keeping a drifting copy. Same approach as scripts/build-source-parsers.js.
 *
 * Run automatically on postinstall, and manually via `npm run build:parsers`.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const ENTRIES = [
  { src: path.join(ROOT, 'utils', 'sourceParsers.ts'), out: path.join(ROOT, 'utils', 'sourceParsers.cjs') },
  { src: path.join(ROOT, 'utils', 'captureIngest.ts'), out: path.join(ROOT, 'utils', 'captureIngest.cjs') },
];

async function main() {
  for (const { src, out } of ENTRIES) {
    const result = await esbuild.build({
      entryPoints: [src],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      banner: {
        js: '// GENERATED from utils/sourceParsers.ts / utils/captureIngest.ts — do not edit by hand.\n// Rebuild with: npm run build:parsers',
      },
    });
    fs.writeFileSync(out, result.outputFiles[0].text, 'utf-8');
    console.log(`[build-parsers] wrote ${path.relative(process.cwd(), out)}`);
  }
}

main().catch((err) => {
  console.error('[build-parsers] failed:', err);
  process.exit(1);
});
