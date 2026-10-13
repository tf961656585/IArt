import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_ROOT = process.cwd();
export const TOOLING_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
export const SOURCE_ROOT = path.join(WORKSPACE_ROOT, '.model-assets', 'sources');
export const OUTPUT_ROOT = path.join(WORKSPACE_ROOT, '.model-assets', 'packages');
