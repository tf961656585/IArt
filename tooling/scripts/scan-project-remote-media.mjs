#!/usr/bin/env node
/**
 * 项目远程媒体引用扫描器（只读）
 *
 * Usage:
 *   node tooling/scripts/scan-project-remote-media.mjs --project <path>
 */

import { resolve } from 'node:path';
import {
  scanProjectRemoteMediaUrls,
} from '../backend-build-output-api.mjs';

const INVALID_ARGS_ERROR_CODE = 'ERR_INVALID_ARGS';

const buildArgError = (message) => {
  const error = new Error(message);
  error.code = INVALID_ARGS_ERROR_CODE;
  return error;
};

export function parseArgs(argv) {
  const args = { project: '', help: false };
  const unknownTokens = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--project' || token === '-p') {
      args.project = String(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token.startsWith('-')) {
      unknownTokens.push(token);
      continue;
    }
    if (!args.project) {
      args.project = token;
      continue;
    }
    unknownTokens.push(token);
  }

  if (unknownTokens.length > 0) {
    throw buildArgError(`ERR_INVALID_ARGS: unsupported argument(s): ${unknownTokens.join(', ')}`);
  }

  return args;
}

const printUsage = () => {
  console.log('Usage: node tooling/scripts/scan-project-remote-media.mjs --project <path>');
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const projectPath = args.project ? resolve(process.cwd(), args.project) : '';
  if (!projectPath) {
    throw buildArgError('ERR_INVALID_ARGS: Missing --project <path>');
  }

  const findings = scanProjectRemoteMediaUrls(projectPath);
  if (findings.length === 0) {
    console.log('No remote media URLs found.');
    return;
  }

  console.log(`Found ${findings.length} remote URL(s):`);
  for (const item of findings) {
    const lineInfo = item.line ? `:${item.line}` : '';
    const meta = [item.confidence, item.kind].filter(Boolean).join('/');
    console.log(`- ${item.url} (file: ${item.filePath}${lineInfo}${meta ? `, kind: ${meta}` : ''})`);
  }

  process.exitCode = 1;
}

main().catch((err) => {
  if (err && typeof err === 'object' && err.code === INVALID_ARGS_ERROR_CODE) {
    console.error(String(err.message || INVALID_ARGS_ERROR_CODE));
    process.exit(2);
    return;
  }
  console.error(err);
  process.exit(1);
});
