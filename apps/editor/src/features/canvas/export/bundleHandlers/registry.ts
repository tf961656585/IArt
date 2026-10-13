import type { BundleAssetHandler } from './types';

const registry: BundleAssetHandler[] = [];

export const registerBundleAssetHandler = (handler: BundleAssetHandler): void => {
  if (!(handler !== null && handler !== undefined ? handler.id : undefined)) return;
  if (registry.some((existing) => existing.id === handler.id)) return;
  registry.push(handler);
};

export const getBundleAssetHandlers = (): BundleAssetHandler[] => {
  return registry.slice();
};

