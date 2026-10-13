import { describe, it, expect } from 'vitest';
import {
  composeEnhancedTextInput,
  normalizeTextInputNodeData,
  resolveTextInputSeparatorString,
  syncPromptPresetSnapshotsForText,
} from '../enhancedTextNode';
import type { PromptCollectionItem } from '../../../types/promptCollection';

const makePreset = (id: string, content = `${id} 正文`): PromptCollectionItem => ({
  id,
  name: `${id}-名称`,
  content,
  createdAt: 1,
  updatedAt: 1,
});

describe('enhancedTextNode', () => {
  it('按顺序拼接已开启段落，忽略空段', () => {
    const data = normalizeTextInputNodeData({
      segments: [
        { kind: 'local', id: 'a', enabled: true, text: '主体' },
        { kind: 'local', id: 'b', enabled: true, text: '   ' },
        { kind: 'local', id: 'c', enabled: false, text: '不会出现' },
        { kind: 'local', id: 'd', enabled: true, text: '风格' },
      ],
      separator: 'comma',
    });

    expect(composeEnhancedTextInput({ data, options: undefined })).toBe('主体, 风格');
  });

  it('上游段（旧 text-source 拓扑表达）在 normalize 时被剥离，不参与拼接', () => {
    const data = normalizeTextInputNodeData({
      segments: [
        { kind: 'upstream', edgeId: 'e1', enabled: true },
        { kind: 'local', id: 'a', enabled: true, text: '赛博朋克风格' },
      ],
      separator: 'comma',
    });

    expect(data.segments.every((seg) => seg.kind === 'local')).toBe(true);
    expect(composeEnhancedTextInput({ data, options: undefined })).toBe(
      '赛博朋克风格',
    );
  });

  it('会将 `[[pp:<presetId>]]` 展开为插入时快照的 content', () => {
    const data = normalizeTextInputNodeData({
      segments: [
        { kind: 'local', id: 'a', enabled: true, text: 'Hello [[pp:p1]] world' },
      ],
      separator: 'space',
      promptPresetSnapshots: {
        p1: { id: 'p1', name: 'Portrait', content: 'portrait prompt', createdAt: 0, updatedAt: 0 },
      },
    });

    expect(composeEnhancedTextInput({ data, options: undefined })).toBe('Hello portrait prompt world');
  });

  it('快照缺失时默认保留 token（用于 UI 非阻断预览）', () => {
    const data = normalizeTextInputNodeData({
      segments: [{ kind: 'local', id: 'a', enabled: true, text: 'Hello [[pp:missing]] world' }],
      separator: 'space',
    });

    expect(composeEnhancedTextInput({ data, options: undefined })).toBe('Hello [[pp:missing]] world');
  });

  it('promptPresetMissing=throw：快照缺失时抛错阻断执行', () => {
    const data = normalizeTextInputNodeData({
      segments: [{ kind: 'local', id: 'a', enabled: true, text: 'Hello [[pp:missing]] world' }],
      separator: 'space',
    });

    expect(() => composeEnhancedTextInput({
      data,
      options: { promptPresetMissing: 'throw' },
    })).toThrow();
  });

  it('分隔符预设正确映射', () => {
    expect(resolveTextInputSeparatorString({ separator: 'comma' })).toBe(', ');
    expect(resolveTextInputSeparatorString({ separator: 'space' })).toBe(' ');
    expect(resolveTextInputSeparatorString({ separator: 'newline' })).toBe('\n');
    expect(resolveTextInputSeparatorString({ separator: 'doubleNewline' })).toBe('\n\n');
    expect(resolveTextInputSeparatorString({ separator: 'none' })).toBe('');
    expect(resolveTextInputSeparatorString({ separator: 'custom', customSeparator: ' | ' })).toBe(' | ');
  });

  it('旧结构 text 迁移为单本地段，本地段默认开启', () => {
    const data = normalizeTextInputNodeData({ text: 'hello' });
    expect(data.segments).toHaveLength(1);
    expect(data.segments[0]?.kind).toBe('local');
    expect(data.segments[0]?.enabled).toBe(true);
  });

  it('normalize 会透传 promptInterview 字段（用于落盘恢复）', () => {
    const data = normalizeTextInputNodeData({
      segments: [{ kind: 'local', id: 'a', enabled: true, text: 'seed' }],
      promptInterview: {
        version: 1,
        profileId: 'universal-image',
        mediaType: 'image',
        status: 'in_progress',
        turns: [],
        spec: { subject: 'a cat' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(data.promptInterview?.profileId).toBe('universal-image');
    expect(data.promptInterview?.spec.subject).toBe('a cat');
  });
});

describe('syncPromptPresetSnapshotsForText（单文本编辑面快照维护，模型节点 Inspector prompt 口径）', () => {
  it('/ 插入：并入新快照并按文本 prune', () => {
    const existing = makePreset('p-old');
    const inserted = makePreset('p-new');
    const next = syncPromptPresetSnapshotsForText({
      text: '开头 [[pp:p-old]] 中段 [[pp:p-new]] 结尾',
      promptPresetSnapshots: { 'p-old': existing },
      insertedPreset: inserted,
    });

    expect(next).toEqual({ 'p-old': existing, 'p-new': inserted });
  });

  it('删除 token 后对应快照被 prune', () => {
    const keep = makePreset('p-keep');
    const dropped = makePreset('p-drop');
    const next = syncPromptPresetSnapshotsForText({
      text: '只保留 [[pp:p-keep]]',
      promptPresetSnapshots: { 'p-keep': keep, 'p-drop': dropped },
      insertedPreset: undefined,
    });

    expect(next).toEqual({ 'p-keep': keep });
  });

  it('文本中无任何 pp token 时清空快照（返回 undefined）', () => {
    const next = syncPromptPresetSnapshotsForText({
      text: '普通文本',
      promptPresetSnapshots: { 'p-1': makePreset('p-1') },
      insertedPreset: undefined,
    });

    expect(next).toBeUndefined();
  });

  it('插入的预设未写入文本（异常路径）时不留存快照', () => {
    const next = syncPromptPresetSnapshotsForText({
      text: '普通文本',
      promptPresetSnapshots: undefined,
      insertedPreset: makePreset('p-orphan'),
    });

    expect(next).toBeUndefined();
  });

  it('无快照且无插入时保持 undefined', () => {
    const next = syncPromptPresetSnapshotsForText({
      text: '普通文本',
      promptPresetSnapshots: undefined,
      insertedPreset: undefined,
    });

    expect(next).toBeUndefined();
  });
});
