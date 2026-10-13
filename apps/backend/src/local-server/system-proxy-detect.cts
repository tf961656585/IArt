import { execFile } from 'node:child_process';

/**
 * 系统代理检测（Hub「设置 → 网络代理」system 模式的实现）。
 *
 * - macOS：`scutil --proxy`（解析 HTTP/HTTPS Enable/Proxy/Port 与 ProxiesExceptionsList）
 * - Windows：`reg query HKCU\...\Internet Settings`（ProxyEnable / ProxyServer / ProxyOverride）
 * - Linux：best-effort `gsettings org.gnome.system.proxy`（失败按无代理处理）
 *
 * 边界：
 * - PAC（自动配置脚本）与"自动检测"无法在 Node fetch（undici）执行，标记 unsupported，
 *   由调用方降级为直连并留 debug 日志（条件跳过必须留痕）。
 * - SOCKS 代理：undici ProxyAgent 不支持 SOCKS，跳过（同样留痕）。
 * - 解析函数为纯函数、命令执行经 runner 注入，便于 node:test 单测。
 */

type SystemProxyUnsupported = 'pac' | 'auto-detect' | null;

type DetectedSystemProxy = {
  /** http:// 目标使用的代理 URL（空串=无）；格式 http://host:port */
  httpProxy: string;
  /** https:// 目标使用的代理 URL（空串=无）；CONNECT 隧道 */
  httpsProxy: string;
  /** 不走代理的例外 host 列表（已小写、去端口） */
  noProxy: string[];
  /** 检测到但无法支持的配置类型（优先于普通代理结果向调用方传递降级原因） */
  unsupported: SystemProxyUnsupported;
};

type CommandRunner = (command: string, args: string[]) => Promise<string>;

const emptyDetection = (unsupported: SystemProxyUnsupported = null): DetectedSystemProxy => ({
  httpProxy: '',
  httpsProxy: '',
  noProxy: [],
  unsupported,
});

const withPort = (host: string, port: string, scheme: 'http'): string => {
  const cleanHost = host.trim().replace(/^\[|\]$/g, '');
  const cleanPort = port.trim();
  if (!cleanHost) return '';
  return cleanPort ? `${scheme}://${cleanHost}:${cleanPort}` : `${scheme}://${cleanHost}`;
};

const splitList = (value: string, separators: string): string[] =>
  value
    .split(separators)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '' && !entry.startsWith('<'));

/**
 * 例外条目归一化：小写、去空白/引号。
 * 仅剥一层前导 `*`（`*.example.com` → `.example.com`，与 undici noProxy 的 endsWith 语义一致）；
 * 不剥前导 `.`，避免 `.*` 这类含正则通配的退化条目（Windows ProxyOverride 的 `127.*`）
 * 被 undici 当成"任意后缀匹配"而误吞无关域名——这类退化条目保留原样即不匹配（fail closed）。
 */
const normalizeExceptionEntries = (raw: string[]): string[] =>
  raw
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '' && !entry.startsWith('<'))
    .map((entry) => (entry.startsWith('*.') ? entry.slice(1) : entry.slice(entry.startsWith('*') ? 1 : 0)));

/**
 * 解析 `scutil --proxy` 输出。形如：
 *   HTTPEnable : 1
 *   HTTPProxy : 127.0.0.1
 *   HTTPPort : 7890
 *   ProxiesExceptionsList : ( "a", "b" )  多行列表
 */
const parseScutilProxy = (output: string): DetectedSystemProxy => {
  const fields = new Map<string, string>();
  const listFields = new Map<string, string[]>();
  let currentListKey: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (currentListKey !== null) {
      if (/^\s*\)/.test(line)) {
        currentListKey = null;
        continue;
      }
      const item = line.trim().replace(/,$/, '').replace(/^"|"$/g, '');
      if (item) {
        const list = listFields.get(currentListKey) ?? [];
        list.push(item);
        listFields.set(currentListKey, list);
      }
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).trim();
    if (value === '(') {
      currentListKey = key;
      listFields.set(key, []);
      continue;
    }
    fields.set(key, value);
  }

  const isEnabled = (key: string): boolean => fields.get(key) === '1';
  const proxyHost = (enableKey: string, hostKey: string, portKey: string): string => {
    if (!isEnabled(enableKey)) return '';
    return withPort(fields.get(hostKey) ?? '', fields.get(portKey) ?? '', 'http');
  };

  const unsupported: SystemProxyUnsupported =
    fields.get('ProxyAutoConfigEnable') === '1'
      ? 'pac'
      : fields.get('ProxyAutoDetectionEnable') === '1'
        ? 'auto-detect'
        : null;

  const exceptions = normalizeExceptionEntries(listFields.get('ProxiesExceptionsList') ?? []);

  return {
    httpProxy: proxyHost('HTTPEnable', 'HTTPProxy', 'HTTPPort'),
    httpsProxy: proxyHost('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'),
    noProxy: exceptions,
    unsupported,
  };
};

/**
 * 解析 `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` 输出。
 * 形如：`    ProxyEnable    REG_DWORD    0x1` / `    ProxyServer    REG_SZ    127.0.0.1:7890`
 * ProxyServer 兼容两种格式：全局 `host:port` 或按协议 `http=h:p;https=h:p;socks=...`。
 */
const parseWindowsRegistryProxy = (output: string): DetectedSystemProxy => {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s{4}([A-Za-z]+)\s+REG_[A-Z_]+\s+(.*)$/);
    if (!match) continue;
    fields.set(match[1] as string, (match[2] as string).trim());
  }

  if (fields.get('ProxyEnable') !== '0x1') {
    return emptyDetection();
  }

  const server = fields.get('ProxyServer') ?? '';
  let httpProxy = '';
  let httpsProxy = '';
  if (server.includes('=')) {
    // 按协议格式：http=h:p;https=h:p;socks=...（socks 不受 undici 支持，忽略）
    for (const part of server.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const scheme = part.slice(0, eq).trim().toLowerCase();
      const target = part.slice(eq + 1).trim();
      if (!target) continue;
      const url = target.includes('://') ? target : `http://${target}`;
      if (scheme === 'http' && !httpProxy) httpProxy = url;
      else if (scheme === 'https' && !httpsProxy) httpsProxy = url;
    }
    // 只有 http 没有 https 时，https 复用 http 代理（CONNECT 隧道）
    if (httpProxy && !httpsProxy) httpsProxy = httpProxy;
    if (httpsProxy && !httpProxy) httpProxy = httpsProxy;
  } else if (server) {
    // 全局格式：http://host:port（对 https 目标走 CONNECT 隧道）
    const url = server.includes('://') ? server : `http://${server}`;
    httpProxy = url;
    httpsProxy = url;
  }

  const overrideEntries = splitList(fields.get('ProxyOverride') ?? '', ';');
  // Windows 例外形如 `*.example.com` 或 `example.com`；转成 undici noProxy 可识别的 `.example.com`/精确匹配
  const noProxy = normalizeExceptionEntries(
    overrideEntries.map((entry) => (entry.startsWith('*.') ? entry : entry)),
  );

  return { httpProxy, httpsProxy, noProxy, unsupported: null };
};

/**
 * 解析 GNOME gsettings 输出（Linux best-effort）。
 * 输入为 `mode` / `http host` / `http port` / `https host` / `https port` 的返回值集合。
 */
const parseGnomeProxy = (values: {
  mode: string;
  httpHost: string;
  httpPort: string;
  httpsHost: string;
  httpsPort: string;
}): DetectedSystemProxy => {
  const mode = values.mode.replace(/'/g, '').trim();
  if (mode === 'auto') return emptyDetection('pac');
  if (mode !== 'manual') return emptyDetection();
  // gsettings 输出形如 `'127.0.0.1'` / `uint32 7890`：去引号；端口提取数字部分
  const strip = (value: string): string => value.replace(/'/g, '').trim();
  const stripPort = (value: string): string => {
    // gsettings 端口形如 `uint32 7890`：取最后一个数字段
    const match = strip(value).match(/(\d+)\s*$/);
    const digits = match?.[1] ?? '';
    return digits === '0' ? '' : digits;
  };
  return {
    httpProxy: withPort(strip(values.httpHost), stripPort(values.httpPort), 'http'),
    httpsProxy: withPort(strip(values.httpsHost), stripPort(values.httpsPort), 'http'),
    noProxy: [],
    unsupported: null,
  };
};

const execFileRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

const runText = async (runner: CommandRunner, command: string, args: string[]): Promise<string> => {
  try {
    return await runner(command, args);
  } catch {
    return '';
  }
};

const detectMacSystemProxy = async (runner: CommandRunner): Promise<DetectedSystemProxy> =>
  parseScutilProxy(await runText(runner, 'scutil', ['--proxy']));

const detectWindowsSystemProxy = async (runner: CommandRunner): Promise<DetectedSystemProxy> =>
  parseWindowsRegistryProxy(
    await runText(runner, 'reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ]),
  );

const detectLinuxSystemProxy = async (runner: CommandRunner): Promise<DetectedSystemProxy> => {
  const gsettings = (keys: string[]): Promise<string> => runText(runner, 'gsettings', ['get', ...keys]);
  const [mode, httpHost, httpPort, httpsHost, httpsPort] = await Promise.all([
    gsettings(['org.gnome.system.proxy', 'mode']),
    gsettings(['org.gnome.system.proxy.http', 'host']),
    gsettings(['org.gnome.system.proxy.http', 'port']),
    gsettings(['org.gnome.system.proxy.https', 'host']),
    gsettings(['org.gnome.system.proxy.https', 'port']),
  ]);
  return parseGnomeProxy({ mode, httpHost, httpPort, httpsHost, httpsPort });
};

/** 按当前平台检测系统代理；任何执行失败按"无代理"返回（调用方据此走直连）。 */
const detectSystemProxy = async (
  runner: CommandRunner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<DetectedSystemProxy> => {
  if (platform === 'darwin') return detectMacSystemProxy(runner);
  if (platform === 'win32') return detectWindowsSystemProxy(runner);
  return detectLinuxSystemProxy(runner);
};

export {
  type CommandRunner,
  type DetectedSystemProxy,
  type SystemProxyUnsupported,
  detectSystemProxy,
  parseScutilProxy,
  parseWindowsRegistryProxy,
  parseGnomeProxy,
};
