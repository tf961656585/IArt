import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const sharedRequire = createRequire(path.join(process.cwd(), 'testing/integration/__shared_require__.cjs'));

/**
 * Safe type cast for cross-boundary type conversion.
 * Avoids double assertions (as X as Y) in test code.
 */
export function cast<T>(value: unknown): T {
  return value as T;
}

// ─── CJS type-safe require / import helpers ────────────────────
//
// TypeScript infers the return type of `require('...cjs')` or
// `await import('...cjs')` as the module's namespace, which includes
// a `default` property from ESM-CJS interop. Test code only cares
// about the named exports, so these helpers:
//   1. Accept the raw CJS module value
//   2. Extract named exports (skip `default`)
//   3. Assert the result to the caller's desired type via `unknown`
//
// Usage:
//   const router = cjsRequireAs<RouterModule>(sharedRequire('...router.cjs'));
//   const mod = await cjsImportAs<{ foo: () => void }>('../some.cjs');

/**
 * Extract named exports from a CJS require() result and assert to T.
 * Strips the ESM interop `default` wrapper if present.
 */
export function cjsRequireAs<T>(raw: unknown): T {
  const record = raw as Record<string, unknown>;
  if (record && 'default' in record && typeof record === 'object' && record !== null) {
    const { default: _def, ...named } = record;
    return named as T;
  }
  return raw as T;
}

/**
 * Extract named exports from a CJS module while keeping the async call shape.
 * Uses Node's CJS loader so Windows non-ASCII workspace paths do not go through
 * Vite's file URL transform.
 */
export async function cjsImportAs<T>(specifier: string): Promise<T> {
  const raw: unknown = sharedRequire(specifier);
  return cjsRequireAs<T>(raw);
}

// ─── 模式 1：CJS require.cache 替换 ────────────────────────────

/**
 * 创建一个满足 NodeModule 接口的缓存条目。
 * 覆盖测试中实际使用的字段；未使用的字段（parent、require）通过 as NodeModule 统一兜底。
 * @types/node 未来新增必填字段时，只需在此处补齐。
 */
export function createCacheEntry(filename: string, exports: unknown): NodeModule {
  return {
    id: filename,
    filename,
    loaded: true,
    exports,
    path: path.dirname(filename),
    children: [],
    paths: [],
    isPreloading: false,
  } as NodeModule;
}

/**
 * 管理 require.cache 替换的生命周期。
 * 典型用法：
 *
 *   const cjs = createCjsMock();
 *   beforeEach(() => { cjs.replace('some-module', mockExports); });
 *   afterEach(() => { cjs.restore(); });
 */
export function createCjsMock(baseRequire: NodeJS.Require = sharedRequire) {
  const originalModules = new Map<string, NodeModule | undefined>();

  return {
    /** 将 specifier 指向的 CJS 缓存替换为自定义 exports */
    replace(specifier: string, exports: unknown) {
      const resolved = baseRequire.resolve(specifier);
      if (!originalModules.has(resolved)) {
        originalModules.set(resolved, baseRequire.cache[resolved]);
      }
      baseRequire.cache[resolved] = createCacheEntry(resolved, exports);
    },

    /** 恢复所有被替换的 CJS 缓存条目 */
    restore() {
      for (const [resolved, original] of originalModules.entries()) {
        if (original) {
          baseRequire.cache[resolved] = original;
          continue;
        }
        delete baseRequire.cache[resolved];
      }
      originalModules.clear();
    },

    /** 底层 require 实例，供需要 require() 加载的场景使用 */
    require: baseRequire,
  };
}

// ─── CJS cache 工具（替代测试文件中重复的 createRequire 样板）───────

export { sharedRequire };

/**
 * 清除指定路径的 CJS 模块缓存条目。
 * 用于测试间确保 cjsImportAs() 重新加载 .cjs 模块。
 */
export function clearCjsCache(modulePath: string): void {
  delete sharedRequire.cache[modulePath];
}

/**
 * 将 specifier 解析为绝对路径（等价于 require.resolve）。
 * 不触发模块加载，只返回解析后的路径。
 */
export function resolveCjsPath(specifier: string): string {
  return sharedRequire.resolve(specifier);
}

// ─── 模式 2：Module._load 劫持 ────────────────────────────────

type ModuleLoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

/**
 * 劫持 Module._load，通过拦截表映射 request → mock exports。
 *
 * 返回 restore 函数，调用后恢复原始 _load。
 *
 * 用法：
 *   const restore = patchModuleLoad({
 *     electron: electronMock,
 *     './update/app-update-runtime.cjs': mockRuntime,
 *     'electron-updater': { autoUpdater: mockAutoUpdater },
 *   });
 *   // ... 运行测试 ...
 *   restore();
 */
export function patchModuleLoad(interceptMap: Record<string, unknown>): () => void {
  const moduleWithLoad = Module as typeof Module & { _load: ModuleLoadFn };
  const originalLoad = moduleWithLoad._load;

  const patchedLoad: ModuleLoadFn = (request, parent, isMain) => {
    if (request in interceptMap) {
      return interceptMap[request];
    }
    return originalLoad.call(Module, request, parent, isMain);
  };

  moduleWithLoad._load = patchedLoad;

  return () => {
    moduleWithLoad._load = originalLoad;
  };
}
