'use client';

import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

import { hasSuggestionOpen } from '@/features/canvas/components/nodes/shared/promptPresetTokenEditorDom';
import { PromptPresetSlashPopover } from '@/features/canvas/components/nodes/shared/PromptPresetSlashPopover';
import {
  PromptPresetTokenEditor,
  type PromptTextSurface,
} from '@/features/canvas/components/nodes/shared/PromptPresetTokenEditor';
import { syncPromptPresetSnapshotsForText } from '@/features/canvas/nodes/textInput/enhancedTextNode';
import type { PromptCollectionItem } from '@/features/canvas/types';
import { usePromptDockStore } from '../promptDockStore';
import type { PromptDockForm } from '../PromptDock.types';

type PromptDockPromptEditorProps = {
  /** 当前创作形态：占位文案随形态切换（spec docs/agent/06「文案原则」） */
  form: PromptDockForm;
  /** 回车发送回调：与主按钮传同一提交函数，保证提交路径同源 */
  onSubmit: (() => void) | undefined;
};

/** 编辑面自适应高度上限（主行 R1(a) 尺寸耦合，见 docs/editor/dock-布局规范.md）：agent 对话行矮一档，生成式多行草稿更高。 */
const EDITOR_MAX_HEIGHT: Record<PromptDockForm, string> = {
  agent: 'max-h-[160px]',
  generate: 'max-h-[200px]',
};

/**
 * PromptDock prompt 编辑面：由共享 token 编辑器承载（spec docs/editor/prompt内联交互.md）。
 *
 * - 输入 / 触发提示词预设候选（PromptPresetSlashPopover），选中插入 `[[pp:<id>]]` 预设 token；
 *   插入即把预设快照并入草稿，删 token 即清快照（快照随 token 生命周期）。
 * - @ 资产引用本编辑面不提供（mentionDisplay 不传，`[[@asset:]]` 按字面量文本渲染）；
 *   开启条件与候选边界见 spec「生效位置」。
 * - 预设 token 在提交前展开为正文（PromptDock.tsx），后端不认识 token 形态。
 * - 回车发送：Enter 提交、Shift+Enter 换行；组合输入与候选选字中的回车不属于提交意图。
 * - 占满主行整行、高度自适应（min 44px，上限随形态），右下角字数计数常驻。
 * - agent 形态受理成功消费草稿（PD-AC-013）后焦点保留在编辑器：清空由 store 完成，
 *   而共享编辑面在程序性替换内容时会重建表面 DOM（key=renderEpoch）导致焦点掉落，
 *   编辑面在「有内容 → 被清空」的转换落定后把焦点交还给新表面（见下方焦点保留 effect）。
 *
 * 视觉对齐原型 promptdock.css `.prompt-editor`：编辑面右下角 prompt 计数。
 */
export function PromptDockPromptEditor({ form, onSubmit }: PromptDockPromptEditorProps) {
  const prompt = usePromptDockStore((s) => s.draft.prompt);
  const promptPresetSnapshots = usePromptDockStore((s) => s.draft.promptPresetSnapshots);
  const setDraft = usePromptDockStore((s) => s.setDraft);
  const agentEntryFocusToken = usePromptDockStore((s) => s.agentEntryFocusToken);
  const surfaceRef = useRef<PromptTextSurface | null>(null);

  // 进入会话后焦点落消息输入框（spec 06「键盘与焦点」：选中驱动进入或「使用 agent」）。
  // 令牌而不是布尔：连续进入同一会话也要再聚焦一次；初始令牌在挂载时记为已消费，
  // 打开项目不会抢焦点。延后到宏任务的理由与下面的清空聚焦相同——进入是 store 变更，
  // 表面 DOM 会在本轮渲染后重建，同步 focus 只会落在即将卸载的旧表面上。
  const seenEntryFocusTokenRef = useRef(agentEntryFocusToken);
  useEffect(() => {
    if (agentEntryFocusToken === seenEntryFocusTokenRef.current) return;
    seenEntryFocusTokenRef.current = agentEntryFocusToken;
    const timer = window.setTimeout(() => {
      surfaceRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [agentEntryFocusToken]);

  // 焦点保留（PD-AC-013）：prompt 从非空转为空（受理成功消费 / 「清空后进入」）时，
  // 把焦点交回编辑器，用户可直接输入下一条消息。用户自己删空文本时焦点本就在编辑器内，
  // 这里只是无害重聚焦。
  //
  // 不能在本 effect 里同步 focus：共享编辑面收到程序性空值时，其 layout effect 会再触发
  // 一次同步重建（renderValue + renderEpoch 变化 → key 变化 → 表面 DOM 换新），而 React
  // 在执行这轮同步重渲染之前先冲刷本轮 passive effects——此刻 focus 只会落在即将被
  // 卸载的旧表面上，重建一发生焦点随之掉落。延迟到宏任务（所有同步提交之后）再经
  // surfaceRef 把焦点交给重建后的新表面，Enter 与提交按钮两条路径同此。
  const hadPromptRef = useRef(prompt.trim().length > 0);
  useEffect(() => {
    const hasPrompt = prompt.trim().length > 0;
    if (!hasPrompt && hadPromptRef.current) {
      hadPromptRef.current = false;
      const timer = window.setTimeout(() => {
        surfaceRef.current?.focus();
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
    hadPromptRef.current = hasPrompt;
  }, [prompt]);

  // 文本变化即按存留 token 剪枝快照：删 token 即清快照，不让快照与文本脱钩。
  const handleChange = useCallback(
    (next: string) => {
      setDraft({
        prompt: next,
        promptPresetSnapshots: syncPromptPresetSnapshotsForText({
          text: next,
          promptPresetSnapshots,
        }),
      });
    },
    [promptPresetSnapshots, setDraft],
  );

  const handleInsertPreset = useCallback(
    ({ nextValue, preset }: { nextValue: string; preset: PromptCollectionItem }) => {
      setDraft({
        prompt: nextValue,
        promptPresetSnapshots: syncPromptPresetSnapshotsForText({
          text: nextValue,
          promptPresetSnapshots,
          insertedPreset: preset,
        }),
      });
    },
    [promptPresetSnapshots, setDraft],
  );

  // 回车发送（聊天框惯例）：Enter 提交、Shift+Enter 换行。
  // IME 防护：输入法组合中的回车属于 IME——用户可能想上屏拼音原文或确认候选词，不是提交意图；
  // isComposing 为真直接放行，keyCode 229（key=Process）对 isComposing 不可靠的环境兜底。
  // / 预设候选打开时回车是选中候选，让给弹层。
  // 可提交性守卫（submitting / 空输入 / 模型未选 / preflight 阻断）不在此复制：全权走主按钮同一提交函数。
  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' || event.shiftKey || onSubmit === undefined) return;
      const native = event.nativeEvent;
      if (native.isComposing || native.keyCode === 229) return;
      const editor = surfaceRef.current?.getElement();
      if (editor instanceof HTMLDivElement && hasSuggestionOpen(editor)) return;
      if (prompt.trim() === '') return;
      // 对齐共享编辑器「编辑器内按键不冒泡到画布」的原则：提交的回车同样不外泄
      event.preventDefault();
      event.stopPropagation();
      onSubmit();
    },
    [onSubmit, prompt],
  );

  return (
    <div className="relative">
      <PromptPresetTokenEditor
        ref={surfaceRef}
        value={prompt}
        onChange={handleChange}
        promptPresetSnapshots={promptPresetSnapshots}
        readOnly={false}
        editingSessionActive
        placeholder={
          form === 'agent'
            ? '想让 Agent 做什么？'
            : '描述你想生成的内容…（/ 预设）'
        }
        className={`min-h-[44px] overflow-y-auto pr-14 ${EDITOR_MAX_HEIGHT[form]}`}
        containerClassName={undefined}
        mentionDisplay={undefined}
        onKeyDown={handleEditorKeyDown}
        data-testid="promptdock-prompt-editor"
      />
      <PromptPresetSlashPopover
        surfaceRef={surfaceRef}
        disabled={false}
        onInsert={handleInsertPreset}
      />
      <span
        className="pointer-events-none absolute right-2 bottom-1.5 rounded-sm bg-card/80 px-1 py-px font-mono text-[11px] text-muted-foreground"
        aria-hidden="true"
      >
        {prompt.length}
      </span>
    </div>
  );
}
