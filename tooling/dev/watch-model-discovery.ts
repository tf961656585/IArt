import fs from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  collectModelEntries,
  renderGeneratedContent,
  GENERATED_FILE,
  MODELS_DIR_PATH,
} from '../scripts/model-discovery-utils';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

const prefix = `${COLORS.gray}[model-discovery]${COLORS.reset}`;
const log = {
  info: (message: string): void => console.log(`${prefix} ${COLORS.cyan}ℹ${COLORS.reset} ${message}`),
  success: (message: string): void => console.log(`${prefix} ${COLORS.green}✔${COLORS.reset} ${message}`),
  warn: (message: string): void => console.warn(`${prefix} ${COLORS.yellow}⚠${COLORS.reset} ${message}`),
  error: (message: string, err?: unknown): void =>
    console.error(`${prefix} ${COLORS.red}✖${COLORS.reset} ${message}`, err ?? ''),
};

const debounce = <T extends (...args: unknown[]) => void>(fn: T, wait: number): T => {
  let timer: NodeJS.Timeout | null = null;

  return ((...args: Parameters<T>): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  }) as T;
};

const generateOnce = async (): Promise<number> => {
  const entries = await collectModelEntries();
  const content = renderGeneratedContent(entries);
  await fs.writeFile(GENERATED_FILE, content, 'utf-8');
  return entries.length;
};

const createRegenerator = () => {
  let running = false;
  let queued = false;

  const execute = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }

    running = true;
    try {
      const count = await generateOnce();
      log.success(`已更新自动发现列表，当前模型数：${count}`);
    } catch (err) {
      log.error('生成自动发现列表失败', err);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void execute();
      }
    }
  };

  return {
    runNow: (): Promise<void> => execute(),
    schedule: debounce(() => void execute(), 500),
  };
};

const registerGracefulShutdown = (watcher: FSWatcher): void => {
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    log.warn(`收到 ${signal}，正在关闭文件监听...`);
    await watcher.close().catch((err) => log.error('关闭监听器失败', err));
    log.success('监听器已关闭，安全退出。');
    process.exit(0);
  };

  (['SIGINT', 'SIGTERM'] satisfies NodeJS.Signals[]).forEach((signal) =>
    process.once(signal, () => void stop(signal)),
  );
};

async function main(): Promise<void> {
  log.info('启动模型目录监听...');
  log.info(`监控目录：${MODELS_DIR_PATH}`);
  log.info('WSL 环境使用轮询模式监听（usePolling=true，间隔 1s）。');

  const regenerator = createRegenerator();
  await regenerator.runNow();

  const watcher = chokidar.watch(MODELS_DIR_PATH, {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    binaryInterval: 1000,
    ignored: [
      /node_modules/,
      /__tests__/,
      /\/shared\//,
    ],
  });

  watcher
    .on('add', (file) => {
      if (file.endsWith('index.ts')) {
        log.info(`检测到新增：${file}`);
        regenerator.schedule();
      }
    })
    .on('change', (file) => {
      if (file.endsWith('index.ts')) {
        log.info(`检测到修改：${file}`);
        regenerator.schedule();
      }
    })
    .on('unlink', (file) => {
      if (file.endsWith('index.ts')) {
        log.warn(`检测到删除：${file}`);
        regenerator.schedule();
      }
    })
    .on('ready', () => log.success('文件监听已就绪'));

  registerGracefulShutdown(watcher);
}

main().catch((err) => {
  log.error('监听进程异常终止', err);
  process.exitCode = 1;
});
