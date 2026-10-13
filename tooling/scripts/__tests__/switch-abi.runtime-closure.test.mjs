import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { __test_only__ } from '../switch-abi.mjs';

const writePackage = (packageDir, packageJson) => {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = true;\n');
};

test('collectPackageProductionDependencies 读取 dependencies 和 optionalDependencies', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-abi-deps-'));
  const packageDir = path.join(tempDir, 'root-package');
  writePackage(packageDir, {
    name: 'root-package',
    version: '1.0.0',
    dependencies: {
      alpha: '1.0.0',
    },
    optionalDependencies: {
      '@scope/bravo': '1.0.0',
    },
    devDependencies: {
      devonly: '1.0.0',
    },
  });

  assert.deepEqual(__test_only__.collectPackageProductionDependencies(packageDir), ['@scope/bravo', 'alpha']);
});

test('copyRuntimeDependencyClosure 复制普通包、scoped 包与传递依赖闭包', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-abi-runtime-'));
  const rootPackageDir = path.join(tempDir, 'root-package');
  const sourceNodeModulesDir = path.join(tempDir, 'node_modules');
  const targetDir = path.join(tempDir, 'target-runtime');

  writePackage(rootPackageDir, {
    name: 'root-package',
    version: '1.0.0',
    dependencies: {
      alpha: '1.0.0',
      '@scope/bravo': '1.0.0',
    },
  });
  writePackage(path.join(sourceNodeModulesDir, 'alpha'), {
    name: 'alpha',
    version: '1.0.0',
    dependencies: {
      nested: '1.0.0',
    },
  });
  writePackage(path.join(sourceNodeModulesDir, '@scope', 'bravo'), {
    name: '@scope/bravo',
    version: '1.0.0',
    optionalDependencies: {
      nested: '1.0.0',
    },
  });
  writePackage(path.join(sourceNodeModulesDir, 'nested'), {
    name: 'nested',
    version: '1.0.0',
  });

  const copied = __test_only__.copyRuntimeDependencyClosure({ rootPackageDir, targetDir });

  assert.deepEqual(copied, ['@scope/bravo', 'alpha', 'nested']);
  assert.equal(fs.existsSync(path.join(targetDir, 'node_modules', 'alpha', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'node_modules', '@scope', 'bravo', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'node_modules', 'nested', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'node_modules', 'devonly', 'package.json')), false);
});
