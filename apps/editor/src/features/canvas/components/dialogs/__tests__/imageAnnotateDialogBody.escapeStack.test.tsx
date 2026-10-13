import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle, OverlayEscapeDispatcher } from '@iart/ui';

import { ImageAnnotateDialogBody } from '../ImageAnnotateDialogBody';
import type {
  AnnotationSnapshot,
  Stroke,
  TextBox,
} from '../imageAnnotateDialogTypes';

/**
 * 标注弹窗内文本编辑会话的 Esc 语义
 *（spec docs/editor/浮层堆栈管理.md 核心规则 6 + 验收 OVL-005「编辑态先于宿主退出」）。
 *
 * 接缝性质：真实分发器 + 真实宿主弹窗（@iart/ui Dialog，包装层自动注册）+ 真实
 * `ImageAnnotateDialogBody`；只把父组件（`ImageAnnotateDialog`）的状态机按同一形状
 * 复刻成测试 harness（编辑会话、历史快照、文本框集合），被测组件的接线方式不变。
 *
 * 保护：编辑会话激活时按 Esc 只退编辑态（弹窗保持打开）；再按 Esc 才退宿主弹窗；
 * 新建会话的 Esc 仍走「撤销新建 / 丢弃该文本框」的状态机分支。
 *
 * 事实依据：文本框可见文字画在 canvas 上（DOM 里只有编辑态的 textarea 与变换手柄），
 * 因此定位文本框用其变换样式，不用文本内容。
 */

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt} className={props.className} />
  ),
}));

const TEXT_ID = 'text-1';
const NEW_TEXT_ID = 'text-new';

const textBox = (id = TEXT_ID, text = '标注文本'): TextBox => ({
  id,
  x: 0.1,
  y: 0.1,
  widthRatio: 0.3,
  rotation: 0,
  fontSizeRatio: 0.1,
  color: '#ffffff',
  text,
});

/** 父组件状态机的测试复刻：与 `ImageAnnotateDialog` 同形状（编辑会话 + 历史快照）。 */
function Harness({ onDialogClose }: { onDialogClose: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [activeTool, setActiveTool] = useState<'brush' | 'text'>('text');
  const [brushColor, setBrushColor] = useState('#ff0000');
  const [brushSize, setBrushSize] = useState(8);
  const [textFontSize, setTextFontSize] = useState(24);
  const [texts, setTexts] = useState<TextBox[]>([textBox()]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [history, setHistory] = useState<AnnotationSnapshot[]>([
    { strokes: [], texts: [textBox()] },
  ]);

  const textsRef = useRef<TextBox[]>(texts);
  textsRef.current = texts;
  const strokesRef = useRef<Stroke[]>([]);
  const editSessionRef = useRef<{ id: string; isNew: boolean; originalText: string } | null>(
    null,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const pushSnapshot = useCallback((snapshot: AnnotationSnapshot) => {
    setHistory((prev) => [...prev, snapshot]);
    setTexts(snapshot.texts);
  }, []);

  const startEditingText = useCallback(
    (id: string, options: { isNew: boolean | undefined } | undefined) => {
      const existing = textsRef.current.find((item) => item.id === id);
      editSessionRef.current = {
        id,
        isNew: options?.isNew === true,
        originalText: existing !== null && existing !== undefined ? existing.text : '',
      };
      setEditingTextId(id);
      setEditingValue(existing !== null && existing !== undefined ? existing.text : '');
    },
    [],
  );

  const commitEditing = useCallback(() => {
    setEditingTextId(null);
    setEditingValue('');
    editSessionRef.current = null;
  }, []);

  const selectedText = useMemo(
    () =>
      selectedTextId === null
        ? null
        : textsRef.current.find((t) => t.id === selectedTextId) ?? null,
    [selectedTextId],
  );

  const noop = useCallback(() => undefined, []);

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) {
          onDialogClose();
          setDialogOpen(false);
        }
      }}
    >
      <DialogContent form="canvas" fill className="p-0 gap-0">
        <DialogTitle>画笔标注</DialogTitle>
        {/* 测试入口：复刻父组件「新建文本 → 进入编辑会话（isNew）」的路径 */}
        <button
          type="button"
          onClick={() => {
            const created = textBox(NEW_TEXT_ID, '新文本');
            setTexts((prev) => [...prev, created]);
            textsRef.current = [...textsRef.current, created];
            setSelectedTextId(NEW_TEXT_ID);
            startEditingText(NEW_TEXT_ID, { isNew: true });
          }}
        >
          新建文本会话
        </button>
        <div data-testid="text-count">{texts.length}</div>
        <ImageAnnotateDialogBody
          activeTool={activeTool}
          brushColor={brushColor}
          brushSize={brushSize}
          canvasRef={canvasRef}
          commitEditing={commitEditing}
          deleteSelectedText={noop}
          editingTextId={editingTextId}
          editingValue={editingValue}
          effectiveTextCount={texts.length}
          exportError={null}
          handleCanvasPointerCancel={noop}
          handleCanvasPointerDown={noop}
          handleCanvasPointerMove={noop}
          handleCanvasPointerUp={noop}
          handleClear={noop}
          handleUndo={noop}
          historyCanUndo={history.length > 1}
          imageRef={imageRef}
          stageRef={stageRef}
          loadError={null}
          loading={false}
          localUrl="blob:test-image"
          pushSnapshot={pushSnapshot}
          redraw={noop}
          saving={false}
          selectedText={selectedText}
          selectedTextId={selectedTextId}
          setActiveTool={setActiveTool}
          setBrushColor={setBrushColor}
          setBrushSize={setBrushSize}
          setEditingTextId={setEditingTextId}
          setEditingValue={setEditingValue}
          setSelectedTextId={setSelectedTextId}
          setTextFontSize={setTextFontSize}
          startEditingText={startEditingText}
          startTransform={noop}
          strokeCount={0}
          strokesRef={strokesRef as MutableRefObject<Stroke[]>}
          syncCanvasSize={noop}
          textFontSize={textFontSize}
          texts={texts}
          textsRef={textsRef as MutableRefObject<TextBox[]>}
          updateSelectedTextStyle={noop}
          contentFrameInStage={{ left: 0, top: 0, width: 400, height: 300 }}
          cancelNewTextByUndoIfPossible={() => false}
          editSessionRef={editSessionRef}
        />
      </DialogContent>
    </Dialog>
  );
}

const editingTextarea = () => document.querySelector('textarea');
const dialogContent = () => document.querySelector('[data-slot="dialog-content"]');
/** 文本框：DOM 里只有变换样式可定位（文字画在 canvas 上）。 */
const textBoxElement = () =>
  document.querySelector<HTMLElement>('[style*="translate(-50%, -50%)"]');

const pressEscape = () => {
  fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
};

const renderHarness = (onDialogClose: () => void) =>
  render(
    <>
      <OverlayEscapeDispatcher />
      <Harness onDialogClose={onDialogClose} />
    </>,
  );

beforeEach(() => {
  cleanup();
});

describe('@spec: OVL-005 标注弹窗内文本编辑会话', () => {
  it('编辑会话激活时 Esc 只退编辑态（弹窗保持），再按 Esc 才退宿主弹窗', () => {
    const onDialogClose = vi.fn();
    renderHarness(onDialogClose);

    // 真实入口：双击文本框进入编辑会话
    const box = textBoxElement();
    expect(box).not.toBeNull();
    fireEvent.doubleClick(box as HTMLElement);
    expect(editingTextarea()).not.toBeNull();

    pressEscape();

    // 编辑态先退：弹窗仍在，宿主未被关闭
    expect(editingTextarea()).toBeNull();
    expect(dialogContent()).not.toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();

    pressEscape();

    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(dialogContent()).toBeNull();
  });

  it('未进入编辑会话时 Esc 直接退宿主弹窗（编辑态层不占栈位）', () => {
    const onDialogClose = vi.fn();
    renderHarness(onDialogClose);

    expect(editingTextarea()).toBeNull();

    pressEscape();

    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('新建会话的 Esc 仍走状态机：丢弃该文本框、退出编辑态，宿主弹窗保持', () => {
    const onDialogClose = vi.fn();
    renderHarness(onDialogClose);
    expect(screen.getByTestId('text-count').textContent).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: '新建文本会话' }));
    expect(editingTextarea()).not.toBeNull();
    expect(screen.getByTestId('text-count').textContent).toBe('2');

    pressEscape();

    // 新建会话无法按撤销取消 → 直接丢弃该文本框（与迁移前的 Esc 分支同一状态机）
    expect(editingTextarea()).toBeNull();
    expect(screen.getByTestId('text-count').textContent).toBe('1');
    expect(dialogContent()).not.toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  it('编辑会话退出后层不残留：下一次 Esc 落到弹窗层，不会被编辑态吞掉', () => {
    const onDialogClose = vi.fn();
    renderHarness(onDialogClose);

    fireEvent.doubleClick(textBoxElement() as HTMLElement);
    pressEscape();
    expect(editingTextarea()).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();

    pressEscape();
    pressEscape();

    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });
});
