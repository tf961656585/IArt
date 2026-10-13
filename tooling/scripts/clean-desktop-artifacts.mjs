#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const distDesktopDir = path.join(repoRoot, 'dist-desktop');

export const cleanDesktopArtifacts = (targetDir = distDesktopDir) => {
  fs.rmSync(targetDir, { recursive: true, force: true });
  console.log(`[clean-desktop-artifacts] removed ${targetDir}`);
};

const isDirectExecution = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  cleanDesktopArtifacts();
}
