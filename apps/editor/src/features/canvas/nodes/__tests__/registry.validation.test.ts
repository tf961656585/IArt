import { describe, it, expect } from 'vitest';
import {
  validateNodeDefinition,
  nodeRegistry,
  type NodeDefinition,
} from '../registry';

/** 构造一个最小合法 NodeDefinition，供各 case 覆盖字段。 */
const makeDefinition = (overrides: Partial<NodeDefinition> & Pick<NodeDefinition, 'type'>): NodeDefinition => ({
  label: 'test',
  description: undefined,
  category: 'input',
  icon: undefined,
  defaultData: {},
  defaultSize: { width: 100, height: 100 },
  sizeStrategy: undefined,
  modelId: undefined,
  providerId: undefined,
  groupId: undefined,
  deletable: undefined,
  copyable: undefined,
  color: undefined,
  executable: undefined,
  bundle: undefined,
  palette: undefined,
  companions: undefined,
  variantGroup: undefined,
  ...overrides,
});

describe('validateNodeDefinition', () => {
  it('defaultSize 缺失时 throw，错误信息含节点 key', () => {
    const def = makeDefinition({ type: 'imageInput', defaultSize: undefined });
    expect(() => validateNodeDefinition(def)).toThrowError(
      /node-def:missing-default-size/,
    );
  });

  it('sizeStrategy dynamic + 合法 producer 不 throw', () => {
    const def = makeDefinition({
      type: 'model',
      sizeStrategy: { mode: 'dynamic', producer: 'resultAreaAutoScale' },
    });
    expect(() => validateNodeDefinition(def)).not.toThrow();
  });

  it('sizeStrategy layoutModel 不 throw（媒体节点模式）', () => {
    const def = makeDefinition({
      type: 'imageInput',
      sizeStrategy: { mode: 'layoutModel' },
    });
    expect(() => validateNodeDefinition(def)).not.toThrow();
  });

  it('sizeStrategy static 不 throw', () => {
    const def = makeDefinition({
      type: 'textInput',
      sizeStrategy: { mode: 'static' },
    });
    expect(() => validateNodeDefinition(def)).not.toThrow();
  });

  it('sizeStrategy 省略（undefined）等价 static，不 throw', () => {
    const def = makeDefinition({ type: 'textInput', sizeStrategy: undefined });
    expect(() => validateNodeDefinition(def)).not.toThrow();
  });
});

describe('baseNodeDefinitions 注册期回归', () => {
  it('所有已注册的 base 节点定义满足契约（defaultSize 存在）', () => {
    // registry.ts 模块加载即注册 baseNodeDefinitions；若任一不满足 defaultSize
    // 存在性校验，模块 import 阶段即 throw，此测试根本无法运行。
    // 这里额外显式校验全部已注册定义，作为回归保护。
    const all = nodeRegistry.getAllDefinitions();
    expect(all.length).toBeGreaterThan(0);
    for (const def of all) {
      expect(() => validateNodeDefinition(def)).not.toThrow();
    }
  });
});
