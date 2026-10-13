#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const INVALID_ARGS_ERROR_CODE = 'ERR_INVALID_ARGS';
export const DEFAULT_FIXTURE_SEED = 'legacy-drop-v1';
export const DEFAULT_FIXTURE_OUT = 'testing/fixtures/legacy-drop';

const buildArgError = (message) => {
  const error = new Error(message);
  error.code = INVALID_ARGS_ERROR_CODE;
  return error;
};

const parseArgs = (argv) => {
  const args = {
    seed: DEFAULT_FIXTURE_SEED,
    out: DEFAULT_FIXTURE_OUT,
    help: false,
  };

  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--seed') {
      args.seed = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--out') {
      args.out = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token.startsWith('-')) {
      unknown.push(token);
      continue;
    }
    unknown.push(token);
  }

  if (unknown.length > 0) {
    throw buildArgError(`ERR_INVALID_ARGS: unsupported argument(s): ${unknown.join(', ')}`);
  }
  if (!args.seed) {
    throw buildArgError('ERR_INVALID_ARGS: --seed must not be empty');
  }
  if (!args.out) {
    throw buildArgError('ERR_INVALID_ARGS: --out must not be empty');
  }

  return args;
};

export const buildFixtureFiles = (seed) => {
  const now = '2026-02-26T00:00:00.000Z';

  return {
    'README.md': [
      '# legacy-drop fixtures',
      '',
      '当前 fixture owner：`testing/fixtures/legacy-drop`',
      '',
      '该目录由 `tooling/scripts/generate-legacy-fixtures.mjs` 生成。',
      '用于“旧数据拒绝策略”回归与手工验证。',
      '',
      'retired owner：`docs/fixtures/legacy-drop`',
      '现役 fixture README 与样本目录均以后端迁移后的 `testing/fixtures/**` 为准，旧 `docs/fixtures/**` 不再代表 current 入口。',
      '',
      `seed: ${seed}`,
      '',
      '样本目录：',
      '- current-valid-project/',
      '- legacy-nodegraph-json/',
      '- legacy-manifest-json/',
      '- legacy-import-bundle/',
      '- legacy-json-storage-project/',
      '',
      '说明：当前仓库仅落地最小可用骨架，不包含真实媒体与大型二进制文件。',
      '',
    ].join('\n'),

    'current-valid-project/README.md': [
      '# current-valid-project',
      '',
      '当前版本样本骨架（version=3）。',
      '用于手工流程验证“当前数据可正常打开”。',
      '',
    ].join('\n'),

    'current-valid-project/index.json': `${JSON.stringify(
      {
        version: 3,
        nodeGraphId: `graph-current-${seed}`,
        updatedAt: now,
        tasksById: {},
        outputsByNodeId: {},
        clearedAtByNodeId: {},
      },
      null,
      2,
    )}\n`,

    'current-valid-project/project.sqlite.placeholder': [
      'This placeholder documents that a real current-valid project should contain project.sqlite.',
      `seed=${seed}`,
      '',
    ].join('\n'),

    'legacy-nodegraph-json/README.md': [
      '# legacy-nodegraph-json',
      '',
      '旧版 nodeGraph.json 样本（应被拒绝）。',
      '',
    ].join('\n'),

    'legacy-nodegraph-json/nodeGraph.json': `${JSON.stringify(
      {
        id: `legacy-nodegraph-${seed}`,
        name: 'legacy-nodegraph',
        nodes: [
          {
            id: 'legacy-node-1',
            type: 'model',
            data: {
              modelId: 'json-extract',
              url: 'http://127.0.0.1:4363/files/a.png?x=1',
            },
          },
        ],
        edges: [],
        settings: {},
      },
      null,
      2,
    )}\n`,

    'legacy-manifest-json/README.md': [
      '# legacy-manifest-json',
      '',
      '仅包含 legacy manifest.json（应被拒绝）。',
      '',
    ].join('\n'),

    'legacy-manifest-json/manifest.json': `${JSON.stringify(
      {
        version: 1,
        name: 'legacy-manifest-only',
        nodeGraphId: `legacy-manifest-${seed}`,
        createdAt: 1700000000000,
        savedAt: 1700000000000,
      },
      null,
      2,
    )}\n`,

    'legacy-import-bundle/README.md': [
      '# legacy-import-bundle',
      '',
      '旧版 index.json 导入包样本（应被拒绝）。',
      '',
    ].join('\n'),

    'legacy-import-bundle/index.json': `${JSON.stringify(
      {
        version: 1,
        nodeGraphId: `legacy-import-${seed}`,
        updatedAt: now,
        tasksById: {
          'legacy-task-1': {
            taskId: 'legacy-task-1',
            status: 'completed',
            output: {
              mediaType: 'image',
              url: '/files/legacy.png',
            },
          },
        },
        outputsByNodeId: {},
      },
      null,
      2,
    )}\n`,

    'legacy-json-storage-project/README.md': [
      '# legacy-json-storage-project',
      '',
      '旧版 JSON 存储样本（应被拒绝且不应生成 project.sqlite）。',
      '',
    ].join('\n'),

    'legacy-json-storage-project/manifest.json': `${JSON.stringify(
      {
        version: 1,
        name: 'legacy-json-storage',
        nodeGraphId: `legacy-storage-${seed}`,
        createdAt: 1700000000000,
        savedAt: 1700000000000,
      },
      null,
      2,
    )}\n`,

    'legacy-json-storage-project/nodeGraph.json': `${JSON.stringify(
      {
        id: `legacy-storage-${seed}`,
        name: 'legacy-storage',
        nodes: [
          {
            id: 'legacy-node-storage-1',
            type: 'imageInput',
            data: {
              imageUrl: 'http://localhost:1234/files/legacy.png?token=1',
            },
          },
        ],
        edges: [],
        settings: {},
      },
      null,
      2,
    )}\n`,
  };
};

const ensureParentDir = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const hashFileSha256 = (filePath) => {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
};

export const writeFixtures = (rootDir, files) => {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relPath);
    ensureParentDir(absPath);
    fs.writeFileSync(absPath, content, 'utf-8');
  }

  const sortedFiles = Object.keys(files)
    .filter((relPath) => relPath !== 'SHA256SUMS')
    .sort((a, b) => a.localeCompare(b));

  const lines = sortedFiles.map((relPath) => {
    const absPath = path.join(rootDir, relPath);
    const hash = hashFileSha256(absPath);
    return `${hash}  ${relPath}`;
  });

  const sumsPath = path.join(rootDir, 'SHA256SUMS');
  fs.writeFileSync(sumsPath, `${lines.join('\n')}\n`, 'utf-8');
};

export const generateLegacyFixtures = (rootDir, seed = DEFAULT_FIXTURE_SEED) => {
  fs.mkdirSync(rootDir, { recursive: true });
  const files = buildFixtureFiles(seed);
  writeFixtures(rootDir, files);
  return {
    rootDir,
    files,
  };
};

const printUsage = () => {
  console.log('Usage: node tooling/scripts/generate-legacy-fixtures.mjs --seed <seed> --out <dir>');
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outDir = path.resolve(process.cwd(), args.out);
  generateLegacyFixtures(outDir, args.seed);

  console.log(`Generated legacy-drop fixtures at: ${outDir}`);
  console.log('Verify checksums with:');
  console.log(`  (cd ${outDir} && shasum -a 256 -c SHA256SUMS)`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === INVALID_ARGS_ERROR_CODE) {
      console.error(String(error.message || INVALID_ARGS_ERROR_CODE));
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  }
}
