import fs from 'node:fs';
import path from 'node:path';

const [targetDir] = process.argv.slice(2);

if (!targetDir) {
  throw new Error('[clean-dist] missing target directory argument');
}

const absoluteTargetDir = path.resolve(process.cwd(), targetDir);
fs.rmSync(absoluteTargetDir, { recursive: true, force: true });
console.log(`[clean-dist] removed ${absoluteTargetDir}`);
