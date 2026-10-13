import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

test('desktop public relay 能力不依赖打包 .env 文件', () => {
  const files = packageJson.build?.files ?? [];
  assert.equal(Array.isArray(files), true, 'build.files 必须是数组');
  assert.equal(files.includes('.env'), false, 'build.files 不得把 .env 作为产品能力必要文件');
  assert.equal(files.includes('.env.example'), true, 'build.files 缺少 .env.example');
});

test('desktop/runtime 直接声明 dotenv 运行时依赖', () => {
  const dependencies = packageJson.dependencies ?? {};
  assert.equal(typeof dependencies.dotenv, 'string');
});
