import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CanvasSelectionCommand } from '../useCanvasSelectionBridge';
import { useMarqueeSelection } from '../useMarqueeSelection';

type ApplySelectionCommand = (
  command: CanvasSelectionCommand,
  reason: string,
) => void;

const MarqueeSelectionHarness = ({
  applySelectionCommand,
}: {
  applySelectionCommand: ApplySelectionCommand;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { startMarquee } = useMarqueeSelection({
    screenToFlowPosition: ({ x, y }) => ({ x, y }),
    applySelectionCommand,
    getFlowNodes: () => [],
    containerRef,
  });

  return (
    <div ref={containerRef}>
      <button
        type="button"
        data-testid="marquee-trigger"
        onMouseDown={(event) => startMarquee(event.clientX, event.clientY)}
      />
    </div>
  );
};

const dispatchSelectStart = (): boolean => {
  const event = new Event('selectstart', { bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('useMarqueeSelection 原生文本选区抑制', () => {
  it('框选会话期间拦截 selectstart（拖拽框选不得连带选中 PromptDock 等覆盖层文字）', () => {
    const applySelectionCommand = vi.fn<ApplySelectionCommand>();
    const { getByTestId } = render(
      <MarqueeSelectionHarness applySelectionCommand={applySelectionCommand} />,
    );

    fireEvent.mouseDown(getByTestId('marquee-trigger'), {
      clientX: 100,
      clientY: 100,
    });

    expect(dispatchSelectStart()).toBe(true);
  });

  it('框选会话结束（mouseup / blur / 卸载）后恢复 selectstart 默认行为', () => {
    const applySelectionCommand = vi.fn<ApplySelectionCommand>();
    const { getByTestId, unmount } = render(
      <MarqueeSelectionHarness applySelectionCommand={applySelectionCommand} />,
    );
    const marqueeTrigger = getByTestId('marquee-trigger');

    fireEvent.mouseDown(marqueeTrigger, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 150 });
    expect(dispatchSelectStart()).toBe(false);
    expect(applySelectionCommand).toHaveBeenCalledTimes(1);

    // blur 路径同样走 cleanupListeners
    fireEvent.mouseDown(marqueeTrigger, { clientX: 100, clientY: 100 });
    fireEvent.blur(window);
    expect(dispatchSelectStart()).toBe(false);

    // 会话进行中卸载，监听必须随组件清理，不得泄漏
    fireEvent.mouseDown(marqueeTrigger, { clientX: 100, clientY: 100 });
    unmount();
    expect(dispatchSelectStart()).toBe(false);
  });
});
