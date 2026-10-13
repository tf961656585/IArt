import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePnpmCommand, shouldUseShellOnWindows } from '../lib/pnpm-runner.mjs';

const repoRoot = process.cwd();
const pnpmCommand = resolvePnpmCommand();

const fail = (message) => {
  console.error(`[verify:desktop-smoke] ${message}`);
  process.exitCode = 1;
};

const formatSpawnFailure = (result) => {
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  return `exit code ${result.status ?? 'unknown'}`;
};

if (process.env.IART_EDITOR_URL || process.env.IART_RENDER_URL) {
  fail('IART_EDITOR_URL / IART_RENDER_URL must be empty for smoke verification.');
}

const requiredPaths = [
  ['backend dist', path.join(repoRoot, 'apps', 'backend', 'dist', 'main.cjs')],
  ['desktop shell dist', path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'main.cjs')],
  ['editor static', path.join(repoRoot, 'apps', 'editor', 'dist-static', 'index.html')],
  ['hub static', path.join(repoRoot, 'apps', 'hub', 'dist-static', 'index.html')],
  ['desktop tray icon', path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'icons', 'tray-icon.png')],
];

for (const [label, filePath] of requiredPaths) {
  if (!fs.existsSync(filePath)) {
    fail(`missing ${label}: ${filePath}`);
  } else {
    console.log(`[verify:desktop-smoke] ok ${label}: ${path.relative(repoRoot, filePath)}`);
  }
}

const packageJsonPath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (pkg.main !== 'apps/desktop-shell/dist/main.cjs') {
  fail(`unexpected package.json main: ${pkg.main}`);
}

const collectFiles = (rootDir) => {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir || !fs.existsSync(currentDir)) continue;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
};

const desktopShellDistDir = path.join(repoRoot, 'apps', 'desktop-shell', 'dist');
const desktopShellJsRuntimeFiles = collectFiles(desktopShellDistDir).filter((filePath) =>
  filePath.endsWith('.js'),
);
if (desktopShellJsRuntimeFiles.length > 0) {
  fail(
    [
      'desktop shell dist must not contain .js runtime files because packaged app.asar inherits root package.json type=module.',
      ...desktopShellJsRuntimeFiles.map((filePath) => `- ${path.relative(repoRoot, filePath)}`),
    ].join('\n'),
  );
} else {
  console.log('[verify:desktop-smoke] ok desktop shell dist uses explicit .cjs runtime files');
}

const desktopShellIpcPath = path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'desktop-shell-ipc.cjs');
const desktopShellResolverPath = path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'window', 'frontend-entry-resolver.cjs');
if (fs.existsSync(desktopShellIpcPath) && fs.existsSync(desktopShellResolverPath)) {
  const shellIpc = fs.readFileSync(desktopShellIpcPath, 'utf8');
  const shellResolver = fs.readFileSync(desktopShellResolverPath, 'utf8');
  const requiredRuntimeContracts = [
    { source: shellIpc, pattern: 'ipcMain.handle("get-hub-bootstrap"', label: 'hub bootstrap IPC' },
    { source: shellIpc, pattern: 'ipcMain.handle("get-editor-bootstrap"', label: 'editor bootstrap IPC' },
    { source: shellIpc, pattern: 'ipcMain.handle("open-editor-window"', label: 'editor open IPC' },
    { source: shellResolver, pattern: 'resolveEditorWindowTarget', label: 'fixed editor entry resolver' },
  ];
  for (const item of requiredRuntimeContracts) {
    if (!item.source.includes(item.pattern)) {
      fail(`desktop shell runtime contract missing: ${item.label}`);
    }
  }
  const forbiddenLegacyContracts = [
    { pattern: "ipcMain.handle('get-local-api-base'", label: 'legacy local api base IPC' },
    { pattern: 'iart://editor', label: 'legacy editor URL protocol' },
    { pattern: 'projectPath=', label: 'query-based project context transport' },
    { pattern: 'view=canvas', label: 'query-based initial view transport' },
  ];
  for (const item of forbiddenLegacyContracts) {
    if (shellIpc.includes(item.pattern) || shellResolver.includes(item.pattern)) {
      fail(`desktop shell still contains legacy contract: ${item.label}`);
    }
  }
  console.log('[verify:desktop-smoke] ok desktop shell exposes bootstrap-driven editor IPC');
}

const editorEntryPath = path.join(repoRoot, 'apps', 'editor', 'dist-static', 'index.html');
if (fs.existsSync(editorEntryPath)) {
  const html = fs.readFileSync(editorEntryPath, 'utf8');
  const disallowedPatterns = [
    { pattern: '/_next/', label: 'next asset path' },
    { pattern: 'src="/assets/', label: 'absolute asset script' },
    { pattern: "src='/assets/", label: 'absolute asset script' },
    { pattern: 'href="/assets/', label: 'absolute asset stylesheet' },
    { pattern: "href='/assets/", label: 'absolute asset stylesheet' },
    { pattern: 'window.location.replace("/', label: 'root redirect script' },
    { pattern: "window.location.replace('/", label: 'root redirect script' },
    { pattern: 'window.location.assign("/', label: 'root assign script' },
    { pattern: "window.location.assign('/", label: 'root assign script' },
    { pattern: 'href="/_next/', label: 'absolute _next href' },
    { pattern: 'src="/_next/', label: 'absolute _next src' },
    { pattern: 'href="/favicon.ico"', label: 'absolute favicon href' },
    { pattern: 'href="/manifest.webmanifest"', label: 'absolute manifest href' },
  ];
  for (const item of disallowedPatterns) {
    if (html.includes(item.pattern)) {
      fail(`editor root entry contains ${item.label}: ${item.pattern}`);
    }
  }
  if (!html.includes('src="/assets/') && !html.includes("src='./assets/") && !html.includes("src=\"./assets/")) {
    fail('editor root entry is not emitted as a dedicated desktop renderer bundle');
  }
  console.log('[verify:desktop-smoke] ok editor root entry uses desktop renderer semantics');
}

const disallowedEditorRouteDirs = ['zh-CN', 'en'];
for (const dir of disallowedEditorRouteDirs) {
  const fullPath = path.join(repoRoot, 'apps', 'editor', 'dist-static', dir);
  if (fs.existsSync(fullPath)) {
    fail(`editor static should not export locale route dir: ${fullPath}`);
  }
}

if (process.exitCode !== 1) {
  const runtimeSmoke = spawnSync(
    pnpmCommand,
    [
      'vitest',
      'run',
      'apps/editor/src/features/hooks/__tests__/useBootstrapClient.desktop.test.tsx',
      'apps/editor/src/features/layout/__tests__/AppShell.desktopBootstrap.test.tsx',
      'testing/integration/desktop.frontendEntryResolver.test.ts',
      'testing/integration/desktop.preloadBridge.test.ts',
      'testing/integration/desktop.mainProcessEditorOpen.test.ts',
      'testing/integration/desktop.hostChainBootstrap.test.ts',
      'testing/integration/desktop.updateLifecycle.test.ts',
      'testing/integration/hub.startupBootstrap.test.ts',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: shouldUseShellOnWindows(pnpmCommand),
    },
  );

  if (runtimeSmoke.status !== 0) {
    fail(`desktop runtime smoke tests failed with ${formatSpawnFailure(runtimeSmoke)}`);
  } else {
    console.log('[verify:desktop-smoke] ok bootstrap-driven desktop runtime smoke');
  }

  const electronProcessE2E = spawnSync('node', ['./tooling/scripts/run-desktop-electron-e2e.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (electronProcessE2E.status !== 0) {
    fail(`desktop real Electron e2e failed with ${formatSpawnFailure(electronProcessE2E)}`);
  } else {
    console.log('[verify:desktop-smoke] ok real Electron process e2e');
  }

  console.log('[verify:desktop-smoke] static ownership checks passed');
}
