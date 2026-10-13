import { describe, expect, it } from 'vitest';
import { cast } from '@/lib/utils';
import type {
  GraphNode,
  AudioInputNodeData,
  ImageInputNodeData,
  TextInputNodeData,
  VideoInputNodeData,
} from '../../types/node';
import { hasMaterialNodeContent, isMaterialNodeType } from '../materialNodeContent';

const makeNode = (params: {
  type: GraphNode['type'];
  data: GraphNode['data'];
}): GraphNode => ({
  id: 'n1',
  type: params.type,
  position: { x: 0, y: 0 },
  data: params.data,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe('isMaterialNodeType', () => {
  it('仅四类素材节点返回 true', () => {
    expect(isMaterialNodeType('textInput')).toBe(true);
    expect(isMaterialNodeType('imageInput')).toBe(true);
    expect(isMaterialNodeType('videoInput')).toBe(true);
    expect(isMaterialNodeType('audioInput')).toBe(true);
    expect(isMaterialNodeType('model')).toBe(false);
    expect(isMaterialNodeType('group')).toBe(false);
  });
});

describe('hasMaterialNodeContent', () => {
  it('空文本输入（本地段全空）无内容；有文本时有内容', () => {
    const empty = makeNode({
      type: 'textInput',
      data: cast<TextInputNodeData>({
        segments: [{ kind: 'local', id: 'l1', enabled: true, text: '' }],
      }),
    });
    expect(hasMaterialNodeContent(empty)).toBe(false);

    const filled = makeNode({
      type: 'textInput',
      data: cast<TextInputNodeData>({
        segments: [{ kind: 'local', id: 'l1', enabled: true, text: '一只猫' }],
      }),
    });
    expect(hasMaterialNodeContent(filled)).toBe(true);
  });

  it('空图片组件（imageUrl 为空）无内容；有 imageUrl 时有内容', () => {
    const empty = makeNode({
      type: 'imageInput',
      data: cast<ImageInputNodeData>({ imageUrl: null }),
    });
    expect(hasMaterialNodeContent(empty)).toBe(false);

    const filled = makeNode({
      type: 'imageInput',
      data: cast<ImageInputNodeData>({ imageUrl: '/files/a.png' }),
    });
    expect(hasMaterialNodeContent(filled)).toBe(true);
  });

  it('空视频输入（videoUrl 为空）无内容；有 videoUrl 时有内容', () => {
    const empty = makeNode({
      type: 'videoInput',
      data: cast<VideoInputNodeData>({ videoUrl: null }),
    });
    expect(hasMaterialNodeContent(empty)).toBe(false);

    const filled = makeNode({
      type: 'videoInput',
      data: cast<VideoInputNodeData>({ videoUrl: '/files/a.mp4' }),
    });
    expect(hasMaterialNodeContent(filled)).toBe(true);
  });

  it('音频输入：非分段模式看 audioUrl；分段模式需存在已切分分段', () => {
    const emptyPlain = makeNode({
      type: 'audioInput',
      data: cast<AudioInputNodeData>({ audioUrl: null, segments: [], segmentModeEnabled: false }),
    });
    expect(hasMaterialNodeContent(emptyPlain)).toBe(false);

    const filledPlain = makeNode({
      type: 'audioInput',
      data: cast<AudioInputNodeData>({ audioUrl: '/files/a.mp3', segments: [], segmentModeEnabled: false }),
    });
    expect(hasMaterialNodeContent(filledPlain)).toBe(true);

    const unsliced = makeNode({
      type: 'audioInput',
      data: cast<AudioInputNodeData>({
        audioUrl: '/files/a.mp3',
        segmentModeEnabled: true,
        segments: [
          { id: 's1', name: '分段 1', startTime: 0, endTime: 5, sliced: false, segmentUrl: undefined },
        ],
      }),
    });
    expect(hasMaterialNodeContent(unsliced)).toBe(false);

    const sliced = makeNode({
      type: 'audioInput',
      data: cast<AudioInputNodeData>({
        audioUrl: '/files/a.mp3',
        segmentModeEnabled: true,
        segments: [
          { id: 's1', name: '分段 1', startTime: 0, endTime: 5, sliced: true, segmentUrl: '/files/seg1.mp3' },
        ],
      }),
    });
    expect(hasMaterialNodeContent(sliced)).toBe(true);
  });

  it('非素材节点不受空内容约束，一律返回 true', () => {
    const model = makeNode({ type: 'model', data: cast<TextInputNodeData>({ label: 'm' }) });
    expect(hasMaterialNodeContent(model)).toBe(true);
  });
});
