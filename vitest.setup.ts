// React 19 的 act 同步 effect 刷新依赖此全局标志，且 react.development.js
// 才导出 exports.act（production 变体剥离了它）。配合 vitest.config.ts 的
// env.NODE_ENV='development'，保证加载到含 act 的 development 变体。
// 必须在任何 import React / @testing-library 之前执行。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import '@testing-library/jest-dom';
import {
  initAutoDiscovery,
  setRuntimeProjectedModels,
} from '@/client/config/models.config';
import { discoverModels } from '@/client/config/modelAutoDiscovery';

// Radix UI（如 Slider）依赖 ResizeObserver；jsdom 环境下需要补一个最小实现。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserver {
    observe() {
      /* noop */
    }
    unobserve() {
      /* noop */
    }
    disconnect() {
      /* noop */
    }
  }
  globalThis.ResizeObserver = ResizeObserver;
}

await initAutoDiscovery();
const discoveredModels = await discoverModels();
setRuntimeProjectedModels(discoveredModels.filter((config) => config.providerId !== 'local'));

// cmdk 在布局阶段可能调用 scrollIntoView；jsdom 环境下补一个最小实现避免报错。
if (typeof globalThis.Element !== 'undefined' && !globalThis.Element.prototype.scrollIntoView) {
  Object.defineProperty(globalThis.Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
    writable: true,
  });
}

// jsdom 的 Blob 未实现 arrayBuffer()；mediaDedup 等路径依赖它，补一个最小 polyfill。
if (
  typeof globalThis.Blob !== 'undefined' &&
  typeof globalThis.Blob.prototype.arrayBuffer !== 'function'
) {
  globalThis.Blob.prototype.arrayBuffer = function arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.matchMedia !== 'function') {
  globalThis.window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {
      /* noop */
    },
    removeListener: () => {
      /* noop */
    },
    addEventListener: () => {
      /* noop */
    },
    removeEventListener: () => {
      /* noop */
    },
    dispatchEvent: () => false,
  });
}
