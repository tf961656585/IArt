import { spawn, spawnSync } from 'node:child_process';

export const resolvePnpmCommand = (env = process.env) => {
  const override = typeof env.IART_PNPM_COMMAND === 'string' ? env.IART_PNPM_COMMAND.trim() : '';
  return override || 'pnpm';
};

export const shouldUseShellOnWindows = (command, platform = process.platform) => {
  if (platform !== 'win32') return false;
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'pnpm' || normalized.endsWith('.cmd') || normalized.endsWith('.bat');
};

export const buildPnpmSpawnTarget = (options = {}) => {
  const { command, shell, ...spawnOptions } = options;
  const resolvedCommand = command || resolvePnpmCommand(spawnOptions.env ?? process.env);
  return {
    command: resolvedCommand,
    options: {
      ...spawnOptions,
      shell: typeof shell === 'boolean' ? shell : shouldUseShellOnWindows(resolvedCommand),
    },
  };
};

export const spawnPnpm = (args, options = {}) => {
  const target = buildPnpmSpawnTarget(options);
  return spawn(target.command, args, target.options);
};

export const spawnPnpmSync = (args, options = {}) => {
  const target = buildPnpmSpawnTarget(options);
  return spawnSync(target.command, args, target.options);
};

