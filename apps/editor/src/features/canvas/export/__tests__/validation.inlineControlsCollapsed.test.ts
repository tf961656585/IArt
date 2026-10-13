import { beforeAll, describe, expect, it } from 'vitest';
import { validateImportPayload } from '../validation';
import { nodeRegistry } from '../../nodes/registry';
import type { NodeDefinition } from '../../nodes/registry';

const TEST_MODEL_ID = '__import-default-inline-test-model__';
const TEST_SANITIZE_MODEL_ID = '__import-default-inline-sanitize-model__';
let sanitizeInputInlineValue: unknown = undefined;

beforeAll(() => {
  if (!nodeRegistry.get(TEST_MODEL_ID)) {
    nodeRegistry.register({
      type: 'model',
      modelId: TEST_MODEL_ID,
      providerId: 'test',
      label: '导入默认值测试模型',
      description: undefined,
      category: 'utility',
      icon: undefined,
      defaultData: {
        label: '导入默认值测试模型',
        modelId: TEST_MODEL_ID,
        formValues: {},
        portMapping: {},
        inlineControlsCollapsed: false,
      },
      defaultSize: { width: 280, height: 180 },
      sizeStrategy: { mode: 'layoutModel' },
      groupId: undefined,
      deletable: undefined,
      copyable: undefined,
      color: undefined,
      executable: undefined,
      bundle: undefined,
      palette: undefined,
      companions: undefined,
      variantGroup: undefined,
    } satisfies NodeDefinition);
  }
  if (!nodeRegistry.get(TEST_SANITIZE_MODEL_ID)) {
    nodeRegistry.register({
      type: 'model',
      modelId: TEST_SANITIZE_MODEL_ID,
      providerId: 'test',
      label: '导入默认值 sanitize 测试模型',
      description: undefined,
      category: 'utility',
      icon: undefined,
      defaultData: {
        label: '导入默认值 sanitize 测试模型',
        modelId: TEST_SANITIZE_MODEL_ID,
        formValues: {},
        portMapping: {},
        inlineControlsCollapsed: false,
      },
      bundle: {
        importable: undefined,
        sanitizeData: (data) => {
          sanitizeInputInlineValue = (data as Record<string, unknown>)['inlineControlsCollapsed'];
          return data;
        },
      },
      defaultSize: { width: 280, height: 180 },
      sizeStrategy: { mode: 'layoutModel' },
      groupId: undefined,
      deletable: undefined,
      copyable: undefined,
      color: undefined,
      executable: undefined,
      palette: undefined,
      companions: undefined,
      variantGroup: undefined,
    } satisfies NodeDefinition);
  }
});

const buildPayload = (dataOverrides?: Record<string, unknown>) => ({
  nodeGraph: {
    id: 'graph-import-test',
    name: '导入测试',
    nodes: [
      {
        id: 'model-1',
        type: 'model',
        position: { x: 0, y: 0 },
        data: {
          modelId: TEST_MODEL_ID,
          formValues: {},
          portMapping: {},
          ...(dataOverrides ?? {}),
        },
      },
    ],
  },
});

describe('validateImportPayload - inlineControlsCollapsed 启动首屏收口', () => {
  const getInlineControlsCollapsed = (result: ReturnType<typeof validateImportPayload>): boolean | undefined =>
    (result.nodeGraph?.nodes?.[0]?.data as { inlineControlsCollapsed?: boolean } | undefined)?.inlineControlsCollapsed;

  it('导入缺省字段模型节点时，按配置默认值补为收起(true)', () => {
    const result = validateImportPayload(buildPayload(), {
      modelInlineControlsCollapsedDefault: true,
    });
    expect(result.valid).toBe(true);
    expect(getInlineControlsCollapsed(result)).toBe(true);
  });

  it('导入缺省字段模型节点时，按配置默认值补为展开(false)', () => {
    const result = validateImportPayload(buildPayload(), {
      modelInlineControlsCollapsedDefault: false,
    });
    expect(result.valid).toBe(true);
    expect(getInlineControlsCollapsed(result)).toBe(false);
  });

  it('导入历史显式展开节点时，首屏仍强制收口为当前 Hub 默认收起', () => {
    const result = validateImportPayload(
      buildPayload({ inlineControlsCollapsed: false }),
      { modelInlineControlsCollapsedDefault: true }
    );
    expect(result.valid).toBe(true);
    expect(getInlineControlsCollapsed(result)).toBe(true);
  });

  it('导入历史显式收起节点时，首屏仍强制收口为当前 Hub 默认展开', () => {
    const result = validateImportPayload(
      buildPayload({ inlineControlsCollapsed: true }),
      { modelInlineControlsCollapsedDefault: false }
    );
    expect(result.valid).toBe(true);
    expect(getInlineControlsCollapsed(result)).toBe(false);
  });

  it('导入节点时，sanitizeData 阶段应直接拿到 Hub 首屏默认值', () => {
    sanitizeInputInlineValue = '__unset__';
    const result = validateImportPayload({
      nodeGraph: {
        id: 'graph-import-sanitize-test',
        name: '导入测试',
        nodes: [
          {
            id: 'model-sanitize-1',
            type: 'model',
            position: { x: 0, y: 0 },
            data: {
              modelId: TEST_SANITIZE_MODEL_ID,
              formValues: {},
              portMapping: {},
            },
          },
        ],
      },
    }, {
      modelInlineControlsCollapsedDefault: true,
    });
    expect(result.valid).toBe(true);
    expect(sanitizeInputInlineValue).toBe(true);
    expect(getInlineControlsCollapsed(result)).toBe(true);
  });
});
