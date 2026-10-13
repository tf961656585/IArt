import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnPnpm as spawnPnpmWithDefaults, spawnPnpmSync as spawnPnpmSyncWithDefaults } from '../lib/pnpm-runner.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);

const readOption = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = args[index];
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    return value ? value.trim() : null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('-')) return null;
  return value.trim();
};

const parseIntOption = (name, fallback) => {
  const raw = readOption(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const appendNodeOptions = (existing, extraFlags) => {
  const current = String(existing || '').trim();
  const missing = (extraFlags || []).filter((flag) => !current.includes(flag));
  return [current, ...missing].filter(Boolean).join(' ').trim();
};

const printHelp = () => {
  console.log(
    `
Usage:
  pnpm desktop:dev:debug [--static] [--no-build] [--clean|--no-clean] [--no-next]
  pnpm desktop:dev:debug [--next-port 3000] [--next-host 127.0.0.1] [--next-script dev|dev:full]
  pnpm desktop:dev:debug [--auto-exit-ms 15000]
  pnpm desktop:dev:debug --editor-url http://127.0.0.1:3000 [--no-next]

What it does:
  - Default (recommended for debugging renderer/UI): starts Next dev server (unminified React) + Electron
  - With --static: builds desktop editor static files (production/minified) + Electron

Debug stack hints:
  - Enables Node source maps for Electron main process via NODE_OPTIONS=--enable-source-maps
  - Enables Electron logging/stack dumping via ELECTRON_ENABLE_LOGGING / ELECTRON_ENABLE_STACK_DUMPING

Examples:
  pnpm desktop:dev:debug
  pnpm desktop:dev:debug --static
  pnpm desktop:dev:debug --static --no-clean
  pnpm desktop:dev:debug --next-script dev:full
  pnpm desktop:dev:debug --auto-exit-ms 15000
`.trim(),
  );
};

if (hasFlag('-h') || hasFlag('--help')) {
  printHelp();
  process.exit(0);
}

const editorUrlOverride = readOption('--editor-url');
const editorMode = (() => {
  if (hasFlag('--static') || hasFlag('--editor-static')) return 'static';
  if (hasFlag('--dev') || hasFlag('--next-dev') || hasFlag('--editor-dev') || editorUrlOverride) return 'dev';
  return 'dev';
})();

const shouldClean = (() => {
  if (hasFlag('--clean')) return true;
  if (hasFlag('--no-clean')) return false;
  // 默认：static 模式下做一次干净构建；dev 模式下尽量不清缓存，提升日常调试效率
  return editorMode === 'static';
})();

const shouldStartNext = editorMode === 'dev' && !hasFlag('--no-next') && !editorUrlOverride;
const nextScript = readOption('--next-script') || (hasFlag('--full') ? 'dev:full' : 'dev');
const nextHost = readOption('--next-host') || '127.0.0.1';
const nextPort = parseIntOption('--next-port', 3000);
const autoExitMs = parseIntOption('--auto-exit-ms', 0);
const nextUrl = (() => {
  if (editorUrlOverride) return editorUrlOverride;
  const normalizedHost = nextHost === '0.0.0.0' ? '127.0.0.1' : nextHost;
  return `http://${normalizedHost}:${nextPort}`;
})();
const nextProbe = (() => {
  try {
    const parsed = new URL(nextUrl);
    const host = String(parsed.hostname || '').trim();
    if (!host) return null;
    const port =
      parsed.port && parsed.port.trim()
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === 'https:'
          ? 443
          : 80;
    if (!Number.isFinite(port)) return null;
    return { host, port };
  } catch {
    return null;
  }
})();

const isWin = process.platform === 'win32';
const shellEntry = path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'main.cjs');
const preloadEntry = path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'preload.cjs');
const backendEntry = path.join(repoRoot, 'apps', 'backend', 'dist', 'main.cjs');
const backendConfigStoreEntry = path.join(repoRoot, 'apps', 'backend', 'dist', 'local-server', 'config-store.cjs');
const editorSourceRoot = path.join(repoRoot, 'apps', 'editor', 'src');
const editorStaticDir = path.join(repoRoot, 'apps', 'editor', 'dist-static');
const hubSourceRoot = path.join(repoRoot, 'apps', 'hub', 'src');
const hubStaticDir = path.join(repoRoot, 'apps', 'hub', 'dist-static');

const spawnPnpm = (pnpmArgs, extraEnv) => {
  return spawnPnpmWithDefaults(pnpmArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...(extraEnv || {}) },
    detached: !isWin,
  });
};

const killProcessTree = (child) => {
  if (!child || typeof child.pid !== 'number') return;
  if (child.killed) return;

  if (isWin) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: true,
      });
      return;
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // ignore
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
};

const runPnpmSync = (pnpmArgs, extraEnv) => {
  const result = spawnPnpmSyncWithDefaults(pnpmArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...(extraEnv || {}) },
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const error = new Error(`[desktop:dev:debug] pnpm ${pnpmArgs.join(' ')} failed (exit=${result.status})`);
    error.exitCode = result.status;
    throw error;
  }
  if (result.status == null && result.signal) {
    const error = new Error(`[desktop:dev:debug] pnpm ${pnpmArgs.join(' ')} terminated (signal=${result.signal})`);
    error.exitCode = 1;
    throw error;
  }
};

const verifyPathExists = async (label, targetPath) => {
  try {
    await fs.stat(targetPath);
    console.log(`[desktop:dev:debug] ${label}: ${targetPath}`);
  } catch {
    throw new Error(`[desktop:dev:debug] missing ${label}: ${targetPath}`);
  }
};

const probeHttp = async (label, url) => {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    console.log(`[desktop:dev:debug] ${label}: ${response.status} ${url}`);
    return response.ok || response.status === 307 || response.status === 308;
  } catch (error) {
    console.warn(`[desktop:dev:debug] ${label} probe failed: ${url}`, error);
    return false;
  }
};

const isPortOpen = (host, port, timeoutMs = 350) =>
  new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });

const waitForPort = async ({ host, port, timeoutMs = 25000, intervalMs = 300 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
     
    const ok = await isPortOpen(host, port, Math.min(350, intervalMs));
    if (ok) return true;
     
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
};

const failIfPortAlreadyBound = async ({ host, port, label, guidance }) => {
  const occupied = await isPortOpen(host, port);
  if (!occupied) {
    return;
  }

  const suffix = guidance ? ` ${guidance}` : '';
  throw new Error(
    `[desktop:dev:debug] ${label} port ${host}:${port} is already occupied before startup. Refusing to reuse an uncontrolled dev server.${suffix}`,
  );
};

let desktopProc = null;
let nextProc = null;
let hubProc = null;
let shuttingDown = false;

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcessTree(desktopProc);
  killProcessTree(nextProc);
  killProcessTree(hubProc);
  process.exit(code);
};

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

const main = async () => {
  if (!hasFlag('--no-build')) {
    console.log('[desktop:dev:debug] building desktop runtime: pnpm build:desktop-runtime');
    runPnpmSync(['build:desktop-runtime']);
  } else {
    console.log('[desktop:dev:debug] skip build:desktop-runtime (--no-build)');
  }

  await verifyPathExists('desktop shell entry', shellEntry);
  await verifyPathExists('desktop preload entry', preloadEntry);
  await verifyPathExists('backend entry', backendEntry);
  await verifyPathExists('backend config store entry', backendConfigStoreEntry);
  await verifyPathExists('editor source owner', editorSourceRoot);
  await verifyPathExists('hub source owner', hubSourceRoot);

  if (shouldClean) {
    const nextDir = path.join(repoRoot, '.next');
    const outDir = path.join(repoRoot, 'out');
    console.log(`[desktop:dev:debug] cleaning cache: ${nextDir}`);
    await fs.rm(nextDir, { recursive: true, force: true });
    console.log(`[desktop:dev:debug] cleaning export output: ${outDir}`);
    await fs.rm(outDir, { recursive: true, force: true });
  }

  if (editorMode === 'dev') {
    console.log(`[desktop:dev:debug] editor mode: Next dev (${nextUrl})`);

    if (!editorUrlOverride && nextProbe) {
      await failIfPortAlreadyBound({
        host: nextProbe.host,
        port: nextProbe.port,
        label: 'Next dev',
        guidance: 'Stop the external service or pass --editor-url to opt into an explicit external editor endpoint.',
      });
    }

    if (shouldStartNext) {
      const nextArgs = (() => {
        const baseArgs = ['run', nextScript];
        if (nextScript === 'dev' && Number.isFinite(nextPort) && nextPort > 0) {
          // pnpm 会把 `--` 透传给 next；next 会将其视为“结束解析 options”，导致 `-p` 被当成目录参数
          // 因此这里直接追加端口参数，不使用 `--` 分隔符。
          return [...baseArgs, '-p', String(nextPort)];
        }
        return baseArgs;
      })();
      console.log(`[desktop:dev:debug] starting Next dev: pnpm ${nextArgs.join(' ')}`);
      nextProc = spawnPnpm(nextArgs, {
        NEXT_TELEMETRY_DISABLED: '1',
      });

      nextProc.on('exit', (code, signal) => {
        if (shuttingDown) return;
        console.warn(`[desktop:dev:debug] Next dev exited (code=${code}, signal=${signal})`);
      });

      const ready = nextProbe ? await waitForPort({ host: nextProbe.host, port: nextProbe.port }) : false;
      if (!ready) {
        console.warn(
          `[desktop:dev:debug] Next dev not ready after waiting. You can still open Hub, but Editor may fail to load: ${nextUrl}`,
        );
      }
    } else {
      const skipReason = editorUrlOverride ? '--editor-url' : '--no-next';
      console.warn(
        `[desktop:dev:debug] Next dev is not running (skip start due to ${skipReason}). Editor may fail to load: ${nextUrl}`,
      );
    }
  }

  const hubHost = '127.0.0.1';
  const hubPort = 3200;
  const hubUrl = `http://${hubHost}:${hubPort}`;
  await failIfPortAlreadyBound({
    host: hubHost,
    port: hubPort,
    label: 'Hub dev',
    guidance: 'Stop the external service before running this command so Desktop Shell always points at a controlled Hub dev server.',
  });
  const hubArgs = ['node', './tooling/dev/hub-dev-server.mjs', '--host', hubHost, '--port', String(hubPort)];
  console.log(`[desktop:dev:debug] starting Hub dev: pnpm ${hubArgs.join(' ')}`);
  hubProc = spawnPnpm(hubArgs);
  hubProc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.warn(`[desktop:dev:debug] Hub dev exited (code=${code}, signal=${signal})`);
  });

  const hubReady = await waitForPort({ host: hubHost, port: hubPort, timeoutMs: 10000 });
  if (!hubReady) {
    throw new Error(`[desktop:dev:debug] Hub dev not ready: ${hubUrl}`);
  }

  await verifyPathExists('hub static owner', hubStaticDir);
  await probeHttp('hub dev probe', `${hubUrl}/`);
  if (editorMode === 'dev') {
    await probeHttp('editor dev probe', nextUrl);
  } else {
    await verifyPathExists('editor static owner', editorStaticDir);
  }

  console.log('[desktop:dev:debug] clearing inherited IART_EDITOR_URL / IART_RENDER_URL before spawning child processes');
  const debugEnv = {
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    IART_DEVTOOLS: '1',
    NODE_OPTIONS: appendNodeOptions(process.env.NODE_OPTIONS, ['--enable-source-maps', '--trace-warnings']),
    IART_EDITOR_URL: '',
    IART_RENDER_URL: '',
    IART_DEV_EDITOR_URL: '',
    IART_HUB_DEV_URL: hubUrl,
    ...(editorMode === 'dev'
      ? {
          IART_DEV_EDITOR_URL: nextUrl,
        }
      : {}),
  };

  console.log('[desktop:dev:debug] starting Electron: pnpm desktop:dev');
  const electronStartedAt = Date.now();
  desktopProc = spawnPnpm(['desktop:dev'], debugEnv);

  desktopProc.on('exit', (code, signal) => {
    const normalized = typeof code === 'number' ? code : signal ? 1 : 0;
    const runtimeMs = Date.now() - electronStartedAt;
    if (!shuttingDown && normalized === 0 && runtimeMs < 2500) {
      console.warn('[desktop:dev:debug] Electron exited immediately.');
      console.warn('[desktop:dev:debug] 请确认：是否已有 IARTStudio 实例在运行？');
      console.warn('[desktop:dev:debug] 如有，请在系统托盘右键 -> 退出 后，再重新运行本命令。');
    }
    console.log(`[desktop:dev:debug] Electron exited (code=${code}, signal=${signal})`);
    shutdown(normalized);
  });

  if (autoExitMs > 0) {
    console.log(`[desktop:dev:debug] auto exit armed: ${autoExitMs}ms`);
    setTimeout(() => {
      console.log('[desktop:dev:debug] auto exit reached, shutting down child processes');
      shutdown(0);
    }, autoExitMs);
  }
};

main().catch((error) => {
  console.error('[desktop:dev:debug] failed', error);
  shutdown(1);
});
