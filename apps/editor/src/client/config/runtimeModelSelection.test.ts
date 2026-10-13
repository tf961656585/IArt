import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts';
import {
  setRuntimeProjectedModels,
  type ModelConfigEntry,
  type NodeGraphPortConfig,
} from './models.config';
import {
  listRuntimeProjectedImageToImageModels,
  resolveRuntimeProjectedImageToImageModel,
} from './runtimeModelSelection';

const createPort = (
  id: string,
  name: string,
  dataType: NodeGraphPortConfig['dataType'],
  fieldKey: string,
): NodeGraphPortConfig => ({
  id,
  name,
  dataType,
  fieldKey,
  canonicalKey: undefined,
  description: undefined,
  required: undefined,
  multiple: undefined,
  maxConnections: undefined,
  dataSource: undefined,
  visibleWhen: undefined,
});

const createConfig = (overrides: Partial<ModelConfigEntry> = {}): ModelConfigEntry => {
  const base: ModelConfigEntry = {
    providerId: 'google',
    groupId: undefined,
    label: 'Runtime I2I',
    modelId: 'runtime-i2i',
    defaultTaskType: 'image',
    mode: 'image',
    adapter: {
      generate: async () => ({ ok: true }),
    },
    defaults: undefined,
    visible: undefined,
    role: 'generator',
    description: undefined,
    aliases: undefined,
    routeSegment: undefined,
    workspace: undefined,
    canvasPortSpec: undefined,
    i18n: undefined,
    nodeGraphPorts: {
      inputs: [
        createPort('images', '图片', 'image', 'images'),
      ],
      outputs: [
        createPort('image', '结果', 'image', 'output_image'),
      ],
    },
    videoGenMode: undefined,
    canvasInspector: undefined,
    capabilities: undefined,
    assetCapabilities: undefined,
    assetInputContract: {
      promptFieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
      promptMaxLength: undefined,
      requiredFieldKeys: [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY],
      imageInputFieldKeys: ['images'],
    },
    variantGroup: undefined,
    };
  return Object.assign(base, overrides);
};

describe('runtimeModelSelection', () => {
  afterEach(() => {
    setRuntimeProjectedModels([]);
  });

  it('只返回可用于 i2i 的 runtime projected generator', () => {
    setRuntimeProjectedModels([
      createConfig(),
      createConfig({
        modelId: 'runtime-url-only',
        label: 'URL Only',
        assetCapabilities: {
          taskGroup: undefined,
          mediaInputMode: 'url_only',
          uiGuards: undefined,
          executionTraits: undefined,
        },
      }),
      createConfig({
        modelId: 'runtime-processor',
        label: 'Processor',
        role: 'processor',
      }),
      createConfig({
        modelId: 'runtime-singular-image',
        label: 'Singular Image',
        nodeGraphPorts: {
          inputs: [
            createPort('prompt', '提示词', 'text', 'prompt'),
            createPort('image', '输入图', 'image', 'image'),
          ],
          outputs: [
            createPort('image', '结果', 'image', 'output_image'),
          ],
        },
        assetInputContract: {
          promptFieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
          promptMaxLength: undefined,
          requiredFieldKeys: [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY, 'image'],
          imageInputFieldKeys: ['image'],
        },
      }),
      createConfig({
        modelId: 'runtime-reference-images',
        label: 'Reference Images',
        nodeGraphPorts: {
          inputs: [
            createPort('prompt', '提示词', 'text', 'prompt'),
            createPort('referenceImages', '参考图', 'image', 'referenceImages'),
          ],
          outputs: [
            createPort('image', '结果', 'image', 'output_image'),
          ],
        },
        assetInputContract: {
          promptFieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
          promptMaxLength: undefined,
          requiredFieldKeys: [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY],
          imageInputFieldKeys: ['referenceImages'],
        },
      }),
      createConfig({
        modelId: 'runtime-image-only',
        label: 'Image Only',
        nodeGraphPorts: {
          inputs: [
            createPort('images', '图像', 'image', 'images'),
          ],
          outputs: [
            createPort('image', '结果', 'image', 'output_image'),
          ],
        },
        assetInputContract: {
          promptFieldKey: 'description',
          promptMaxLength: undefined,
          requiredFieldKeys: ['images', 'description'],
          imageInputFieldKeys: ['images'],
        },
      }),
    ]);

    expect(listRuntimeProjectedImageToImageModels().map((item) => item.modelId)).toEqual([
      'runtime-i2i',
      'runtime-singular-image',
      'runtime-reference-images',
    ]);
    const runtimeI2I = resolveRuntimeProjectedImageToImageModel('runtime-i2i');
    const runtimeSingularImage = resolveRuntimeProjectedImageToImageModel('runtime-singular-image');
    const runtimeReferenceImages = resolveRuntimeProjectedImageToImageModel('runtime-reference-images');

    expect(runtimeI2I !== null ? runtimeI2I.modelId : null).toBe('runtime-i2i');
    expect(runtimeSingularImage !== null ? runtimeSingularImage.modelId : null).toBe('runtime-singular-image');
    expect(resolveRuntimeProjectedImageToImageModel('runtime-url-only')).toBeNull();
    expect(runtimeReferenceImages !== null ? runtimeReferenceImages.modelId : null).toBe('runtime-reference-images');
    expect(resolveRuntimeProjectedImageToImageModel('runtime-image-only')).toBeNull();
  });
});
