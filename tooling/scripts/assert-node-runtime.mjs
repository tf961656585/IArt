#!/usr/bin/env node
/**
 * 测试入口的 Node 运行时前置（口径见 `docs/harness/gates.md`「测试入口运行时」）。
 *
 * 为什么需要它：Node 25.6.0 上跑全量 vitest（线程池）时，worker 线程收尾阶段的
 * V8 内存回收会段错误——系统崩溃报告栈为
 * `WorkerThreadData::~WorkerThreadData → MultiIsolatePlatform::DisposeIsolate →
 * Isolate::Deinit → Heap::StartTearDown → CppHeap::StartDetachingIsolate →
 * Heap::PerformGarbageCollection`（`EXC_BAD_ACCESS / SIGSEGV`）。
 * 表现是「用例没有失败、进程随机退出 139、有时连汇总都打不出来」，跑出来的结果不可信。
 * 该崩溃只与运行时版本相关（同一份代码在 Node 24 上连续全量不复现），所以正确的处置是
 * 在测试启动前把运行时钉死，把「随机崩」换成一句可执行的切换指引。
 *
 * 本模块有两个调用点，共用同一份判据，不维护第二套等价检查：
 * 1. `pnpm test` / `pnpm test:integration` 的第一个命令（先于构建，避免白跑几分钟）；
 * 2. vitest `globalSetup`，覆盖 `npx vitest run`、`pnpm test:watch` 等绕过 package 脚本的入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

/** 读取仓库 `package.json` 的 `engines.node`。 */
export function readSupportedRange(packageJsonPath = path.join(repoRoot, 'package.json')) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const range = packageJson?.engines?.node;
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error(`package.json 缺少 engines.node，无法判定测试运行时：${packageJsonPath}`);
  }
  return range;
}

/**
 * 解析 `engines.node`：本仓只维护 `<major>.x || <major>.x` 形态。
 *
 * 不引第三方 semver：这里只需要「哪些主版本可用」这一位信息，表达式形态由本模块的
 * 测试锁定，出现别的写法会直接报错而不是静默放宽。
 */
export function parseSupportedMajors(range) {
  const parts = String(range ?? '')
    .split('||')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`engines.node 为空：${JSON.stringify(range)}`);
  }
  const majors = [];
  for (const part of parts) {
    const match = /^v?(\d+)\.x$/.exec(part);
    if (!match) {
      throw new Error(
        `engines.node 只支持 "<major>.x || <major>.x" 形态，当前是 ${JSON.stringify(range)}；`
          + '如需别的写法，请同步改 tooling/scripts/assert-node-runtime.mjs 及其测试',
      );
    }
    majors.push(Number(match[1]));
  }
  return majors;
}

/** 判定一个 Node 版本是否落在受支持主版本清单里（纯函数，便于测试）。 */
export function inspectNodeRuntime(options = {}) {
  const range = options.supportedRange ?? readSupportedRange(options.packageJsonPath);
  const version = String(options.version ?? process.version);
  const majors = parseSupportedMajors(range);
  const match = /^v?(\d+)\./.exec(version);
  if (!match) {
    throw new Error(`无法解析 Node 版本：${JSON.stringify(version)}`);
  }
  const major = Number(match[1]);
  return { version, range, major, supportedMajors: majors, ok: majors.includes(major) };
}

/** 不支持时的用户可见文案：只讲「为什么不能跑」与「怎么切」，不倾倒内部细节。 */
export function formatUnsupportedRuntimeMessage({ version, range }) {
  return [
    `✖ 当前 Node ${version} 不在测试支持的运行时范围内（engines.node = ${range}）。`,
    '',
    '  已知问题：Node 25 在 vitest 线程池的 worker 收尾阶段会在 V8 内存回收里段错误，',
    '  表现为「没有失败用例、进程随机退出 139」，跑出来的结果不可信。',
    '',
    '  切换到 Node 24（仓库根已提供 .nvmrc）：',
    '    nvm use 24        # 已安装 24.x；nvm 不在 PATH 时先 source 你的 nvm 安装脚本',
    '    nvm install 24    # 未安装时先装',
    '  切换后直接重跑即可，不用手动重建原生模块（pnpm test 会按当前 Node 重建 better-sqlite3）。',
  ].join('\n');
}

/** 不受支持时抛错（CLI 转成退出码 1，vitest globalSetup 直接中断测试）。 */
export function assertSupportedNodeRuntime(options = {}) {
  const result = inspectNodeRuntime(options);
  if (!result.ok) {
    const error = new Error(formatUnsupportedRuntimeMessage(result));
    error.code = 'ERR_UNSUPPORTED_TEST_NODE_RUNTIME';
    throw error;
  }
  return result;
}

/** vitest `globalSetup` 入口（同一判据，覆盖所有 vitest 调用方式）。 */
export function setup() {
  assertSupportedNodeRuntime();
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    const result = assertSupportedNodeRuntime();
    console.log(`[node-runtime] Node ${result.version} 在支持范围内（${result.range}）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
