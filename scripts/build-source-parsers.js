
/**
 * Transpiles utils/sourceParsers.ts (a pure parser module, tested via Vitest)
 * into utils/sourceParsers.cjs so the Electron main process — CommonJS — can
 * require the exact same implementation instead of keeping a drifting copy.
 *
 * Uses esbuild (already present via Vite) to strip TypeScript reliably; a
 * hand-rolled regex strip cannot handle type annotations in signatures.
 *
 * Run automatically on postinstall, and manually via `npm run build:parsers`.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'utils', 'sourceParsers.ts');
const OUT = path.join(__dirname, '..', 'utils', 'sourceParsers.cjs');

async function main() {
  const result = await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    banner: {
      js: '// GENERATED from utils/sourceParsers.ts — do not edit by hand.\n// Rebuild with: npm run build:parsers',
    },
  });
  fs.writeFileSync(OUT, result.outputFiles[0].text, 'utf-8');
  console.log(`[build-source-parsers] wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error('[build-source-parsers] failed:', err);
  process.exit(1);
});
