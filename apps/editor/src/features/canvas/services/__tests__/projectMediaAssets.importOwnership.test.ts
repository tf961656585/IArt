import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@iart/contracts';
import { createNodeGraph } from '../../types/nodeGraph';
import {
  createMediaAssetFixture,
  createModelDataFixture,
  createModelNodeFixture,
  createResultAreaMediaSlotFixture,
  createTestNodeGraphParams,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import { createResultAreaEmbeddedData } from '../resultAreaEmbeddedFactory';
import type { ModelNodeData } from '../../types';
import { remapImportedProjectMediaAssets } from '../projectMediaAssets';

const buildMediaAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset =>
  createMediaAssetFixture({
    id: 'asset-image-1',
    mediaType: 'image',
    original: {
      url: '/files/imported-image.png',
      projectRef: null,
      fileKey: null,
      sourceUrl: null,
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: 128,
      width: 640,
      height: 360,
      durationMs: null,
      fps: null,
    },
    thumbnail: {
      url: '/files/thumbnails/imported-image.webp',
      mimeType: 'image/webp',
      width: 256,
      height: 144,
      status: 'ready',
      generatedAt: 2,
      error: null,
    },
    lifecycle: {
      createdAt: 1,
      updatedAt: 2,
    },
    ...overrides,
  });

const buildResultAreaSlot = () =>
  createResultAreaMediaSlotFixture({
    id: 'item-1',
    itemType: 'media',
    mediaType: 'image',
    assetId: 'asset-image-1',
    value: null,
    createdAt: 1,
    updatedAt: 1,
  });

describe('remapImportedProjectMediaAssets', () => {
  it('会剥离导入包里的 thumbnail 正式状态，只保留 original 资产信息', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('导入测试'));
    graph.nodes = [
      createModelNodeFixture({
        id: 'model-1',
        position: { x: 0, y: 0 },
        data: createModelDataFixture({
          resultArea: createResultAreaEmbeddedData({
            outputSlotIds: undefined,
            slots: [buildResultAreaSlot()],
            collapsed: false,
            targetKeyId: 'resultArea-1',
          }),
        }),
      }),
    ];

    const result = remapImportedProjectMediaAssets({
      nodeGraph: graph,
      mediaAssets: {
        'asset-image-1': buildMediaAsset(),
      },
      existingMediaAssets: {},
    });

    expect(result.mediaAssets['asset-image-1']?.thumbnail).toEqual({
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing',
      generatedAt: null,
      error: null,
    });
  });

  it('已有同 original 的正式资产时，不会因为导入包自带 thumbnail 而错误复制新 assetId', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('导入测试'));
    graph.nodes = [
      createModelNodeFixture({
        id: 'model-1',
        position: { x: 0, y: 0 },
        data: createModelDataFixture({
          resultArea: createResultAreaEmbeddedData({
            outputSlotIds: undefined,
            slots: [buildResultAreaSlot()],
            collapsed: false,
            targetKeyId: 'resultArea-1',
          }),
        }),
      }),
    ];

    const result = remapImportedProjectMediaAssets({
      nodeGraph: graph,
      mediaAssets: {
        'asset-image-1': buildMediaAsset(),
      },
      existingMediaAssets: {
        'asset-image-1': buildMediaAsset({
          thumbnail: {
            url: '/files/thumbnails/existing-image.webp',
            mimeType: 'image/webp',
            width: 320,
            height: 180,
            status: 'ready',
            generatedAt: 9,
            error: null,
          },
        }),
      },
    });

    expect(Object.keys(result.mediaAssets)).toEqual(['asset-image-1']);
    const firstNode = result.nodeGraph.nodes[0];
    const slots =
      firstNode?.type === 'model'
        ? (firstNode.data as ModelNodeData).resultArea.slots
        : [];
    const firstSlot = slots[0];
    expect(firstSlot !== undefined ? firstSlot.assetId : undefined).toBe('asset-image-1');
  });
});
