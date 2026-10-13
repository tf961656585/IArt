#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.next',
  'dist-desktop',
  'node_modules',
  'out',
]);

const DISALLOWED_MARKERS = ['(新增)', '(新增或修改)', '（新增）', '（新增或修改）'];

const includesDisallowedMarker = (name) => DISALLOWED_MARKERS.some((marker) => name.includes(marker));

const WINDOWS_DISALLOWED_CHARS = /[<>:"\\|?*]/;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const getWindowsUnsafeReason = (name) => {
  if (WINDOWS_DISALLOWED_CHARS.test(name)) return 'disallowed-char';
  if (name.endsWith(' ') || name.endsWith('.')) return 'trailing-dot-or-space';
  if (WINDOWS_RESERVED_NAMES.test(name)) return 'reserved-device-name';
  return null;
};

const walk = (startDir) => {
  const markerHits = [];
  const windowsHits = [];
  const stack = [startDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);

      if (includesDisallowedMarker(entry.name)) {
        markerHits.push(relPath);
      }

      const windowsReason = getWindowsUnsafeReason(entry.name);
      if (windowsReason) {
        windowsHits.push(`${relPath} (${windowsReason})`);
      }

      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(fullPath);
      }
    }
  }

  return { markerHits: markerHits.sort(), windowsHits: windowsHits.sort() };
};

const main = () => {
  const { markerHits, windowsHits } = walk(root);
  if (markerHits.length === 0 && windowsHits.length === 0) {
    return;
  }

  if (markerHits.length > 0) {
    console.error('Found disallowed filename markers (e.g. "(新增)") in the repo:');
    for (const hit of markerHits) {
      console.error(`- ${hit}`);
    }
    console.error('');
  }

  if (windowsHits.length > 0) {
    console.error('Found Windows-unsafe file/directory names in the repo:');
    for (const hit of windowsHits) {
      console.error(`- ${hit}`);
    }
    console.error('');
  }
  process.exit(1);
};

main();
