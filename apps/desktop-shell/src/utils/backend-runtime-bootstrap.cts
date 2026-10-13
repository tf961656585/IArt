const DEFAULT_DESKTOP_BACKEND_PORT = 39000;
const DEFAULT_DESKTOP_BACKEND_HOST = '127.0.0.1';

const normalizePort = (value: unknown): number => {
  const numeric = Number.parseInt(typeof value === 'string' && value.trim() ? value.trim() : '', 10);
  if (!Number.isInteger(numeric)) return 0;
  if (numeric < 0 || numeric > 65535) return 0;
  return numeric;
};

interface BootstrapEnv {
  IART_BACKEND_PORT: string | undefined;
  IART_BACKEND_BASE_URL: string | undefined;
}

type RuntimeBootstrapOptions = {
  env: BootstrapEnv | undefined;
  backendPortHint: unknown | undefined;
  backendBaseUrl: unknown | undefined;
  gatewayPortHint: unknown | undefined;
};

const DEFAULT_BOOTSTRAP_OPTIONS: RuntimeBootstrapOptions = {
  env: undefined,
  backendPortHint: undefined,
  backendBaseUrl: undefined,
  gatewayPortHint: undefined,
};

const readBootstrapEnvFromProcess = (): BootstrapEnv => ({
  IART_BACKEND_PORT: process.env['IART_BACKEND_PORT'],
  IART_BACKEND_BASE_URL: process.env['IART_BACKEND_BASE_URL'],
});

const resolveEnv = (env: unknown): BootstrapEnv => {
  if (env && typeof env === 'object') {
    return env as BootstrapEnv;
  }
  return readBootstrapEnvFromProcess();
};

const resolveDesktopBackendRuntimeBootstrap = (options: RuntimeBootstrapOptions = DEFAULT_BOOTSTRAP_OPTIONS) => {
  const env = resolveEnv(options.env);
  const hintedPort = normalizePort(options.backendPortHint);
  const envPort = normalizePort(env.IART_BACKEND_PORT);
  const backendPort = hintedPort || envPort || DEFAULT_DESKTOP_BACKEND_PORT;
  const backendBaseUrl = `http://${DEFAULT_DESKTOP_BACKEND_HOST}:${backendPort}`;

  return {
    backendPort,
    backendBaseUrl,
    envOverrides: {
      IART_BACKEND_PORT: String(backendPort),
    },
  };
};

export {
  DEFAULT_DESKTOP_BACKEND_HOST,
  DEFAULT_DESKTOP_BACKEND_PORT,
  resolveDesktopBackendRuntimeBootstrap,
};
