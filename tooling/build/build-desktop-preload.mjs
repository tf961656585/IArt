import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const preloadEntry = path.join(repoRoot, 'apps', 'desktop-shell', 'src', 'preload.cts');
const preloadOutfile = path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'preload.cjs');

const main = async () => {
  await build({
    absWorkingDir: path.join(repoRoot, 'apps', 'desktop-shell'),
    entryPoints: [preloadEntry],
    outfile: preloadOutfile,
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: ['es2020'],
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  console.log(`[build-desktop-preload] wrote ${preloadOutfile}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
