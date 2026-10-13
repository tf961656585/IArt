#!/usr/bin/env node
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';

// Directories / files considered build or cache artifacts
const targets = [
  'dist',
  'node_modules/.vite',
  'tsconfig.tsbuildinfo',
  '.next',
  'out',
  '.turbo'
];

// Extended removal when --all is passed
const extendedTargets = [
  'node_modules',
  'package-lock.json'
];

const cwd = process.cwd();
const args = process.argv.slice(2);
const isAll = args.includes('--all') || args.includes('-a');

function removePath(p) {
  const abs = resolve(cwd, p);
  if (!existsSync(abs)) {
    console.log(`[skip] ${p} 不存在`);
    return;
  }
  try {
    rmSync(abs, { recursive: true, force: true });
    console.log(`[removed] ${p}`);
  } catch (e) {
    console.error(`[error] 无法删除 ${p}:`, e.message);
  }
}

console.log(`开始清理${isAll ? '（包含 --all 扩展）' : ''}...`);
for (const t of targets) removePath(t);
if (isAll) {
  for (const t of extendedTargets) removePath(t);
}
console.log('清理完成');

console.log('\n提示:');
console.log('  如需彻底重新安装依赖: npm install');
console.log('  如需包含 node_modules 一起清理: npm run clean -- --all');
console.log('  Windows PowerShell 下注意双横杠分隔传参');
