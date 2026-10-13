"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type HTMLAttributes,
} from "react";
import type { PromptCollectionItem } from "@/features/canvas/types";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { X } from "lucide-react";
import { getContentEditableCaretViewportRect } from "./textareaPopoverPosition";
import type { PromptTextSurface } from "./promptTextSurface";
import {
  findBoundaryToken,
  getSelectionRange,
  getSelectionRangeInEditor,
  hasSuggestionOpen,
  parseSegments,
  removeTokenRange,
  serializeEditor,
  setSelectionRange,
  syncSuggestionDataset,
  truncateTooltip,
  tryGetSelectionRange,
  type TokenSegment,
} from "./promptPresetTokenEditorDom";

export type { PromptTextSurface } from "./promptTextSurface";

export type PromptPresetTokenEditorProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange" | "contentEditable"
> & {
  value: string;
  onChange: (nextValue: string) => void;
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
  readOnly: boolean | undefined;
  editingSessionActive: boolean | undefined;
  placeholder: string | undefined;
  containerClassName: string | undefined;
  /**
   * Prompt 长度上限反馈（即时提示，不阻断输入）。
   * 由调用方根据“下游模型最严格限制”或“当前模型自身限制”计算后传入。
   * null/undefined 表示不显示计数器。
   */
  promptLimit?: { max: number; current: number } | null | undefined;
  /**
   * @ 资产引用 token 的显示派生表（assetId → 实时 label）。
   * - undefined：本编辑面不提供 @ 能力，asset token 按字面量文本渲染（不转 chip）。
   * - 提供时：表内 assetId 渲染生效态 chip；表外 assetId 渲染失效态 chip（保留用户文本）。
   * label 由调用方按当前入边实时计算，不持久化（spec：prompt内联交互「身份绑定与编号派生」）。
   */
  mentionDisplay: ReadonlyMap<string, { label: string }> | null | undefined;
};

export const PromptPresetTokenEditor = forwardRef<
  PromptTextSurface,
  PromptPresetTokenEditorProps
>(function PromptPresetTokenEditor(
  {
    value,
    onChange,
    promptPresetSnapshots,
    readOnly = false,
    editingSessionActive = true,
    placeholder,
    containerClassName,
    promptLimit,
    mentionDisplay,
    className,
    onKeyDown,
    onPaste,
    onInput,
    onCompositionStart,
    onCompositionEnd,
    onFocus: onFocusProp,
    onBlur: onBlurProp,
    ...props
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(
    null,
  );
  const suggestionStateRef = useRef<{ pp: boolean; mention: boolean }>({
    pp: false,
    mention: false,
  });
  const suppressNextInputRef = useRef(false);
  const isComposingRef = useRef(false);
  // 组合期 Shift+Enter 挂起的「待补换行」：compositionend 上屏后自动补插一次（一次完成）。
  // 生命周期：组合 Enter+Shift 时置位；compositionend 消费（补插并清）；compositionstart 清
  // （该次按键被 IME 忽略、compositionend 未发生时，标记不得泄漏污染下一次组合）。
  const pendingNewlineAfterCompositionRef = useRef(false);
  const domValueRef = useRef(value);
  const domDivergedRef = useRef(false);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [renderValue, setRenderValue] = useState(() => value ?? "");
  // 组合输入是否进行中（声明式镜像 isComposingRef）：组合期间占位需要隐藏。
  const [composingActive, setComposingActive] = useState(false);
  const isTextEditable = editingSessionActive === true && readOnly !== true;

  const segments = useMemo(() => parseSegments(renderValue), [renderValue]);

  const applyChangeFromDom = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = serializeEditor(editor);
    const selection = getSelectionRange(editor);
    pendingSelectionRef.current = selection;
    domValueRef.current = nextValue;
    domDivergedRef.current = true;
    onChange(nextValue);
  }, [onChange]);

  // 就地插入换行（Enter / 组合期 Shift+Enter 补插共用）：
  // - 光标在编辑器内：在光标处插 `\n` 文本节点；不在（选区缺失/漂移）：先复位到内容末尾再插。
  //   不走「只 onChange 不动 DOM」的兜底——那会让 domValueRef 与 DOM 分叉，触发 renderEpoch
  //   重建 + 焦点掉落；这里 DOM 与 domValueRef 始终同步变更。
  // - 程序性插入不产生原生 input 事件，而候选弹层依赖 input 同步触发上下文：
  //   补派发一次冒泡 input，让弹层按既有机制重新对齐（换行终止 /、@ 匹配时自然关闭）。
  const insertNewline = useCallback(
    (editor: HTMLDivElement): void => {
      let range = getSelectionRangeInEditor(editor);
      if (range === null) {
        const end = serializeEditor(editor).length;
        setSelectionRange(editor, end, end);
        range = getSelectionRangeInEditor(editor);
      }
      if (range === null) {
        // 最终兜底（光标仍不可得）：直接在 DOM 末尾追加换行并同步，不触发重建
        editor.appendChild(document.createTextNode("\n"));
        const end = serializeEditor(editor).length;
        setSelectionRange(editor, end, end);
        applyChangeFromDom();
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      range.deleteContents();
      const node = document.createTextNode("\n");
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      applyChangeFromDom();
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [applyChangeFromDom],
  );

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (onFocusProp !== null && onFocusProp !== undefined) {
        onFocusProp(event);
      }
    },
    [onFocusProp],
  );

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (onBlurProp !== null && onBlurProp !== undefined) {
        onBlurProp(event);
      }
      if (event.defaultPrevented) return;

      const editor = editorRef.current;
      const next = editor ? serializeEditor(editor) : (value ?? "");
      domValueRef.current = next;

      if (domDivergedRef.current || renderValue !== next) {
        domDivergedRef.current = false;
        setRenderValue(next);
        setRenderEpoch((prev) => prev + 1);
      }
    },
    [onBlurProp, renderValue, value],
  );

  const focus = useCallback(() => {
    if (editorRef.current !== null && editorRef.current !== undefined) {
      editorRef.current.focus();
    }
  }, []);

  const setSuggestionOpen = useCallback(
    (kind: "pp" | "mention", open: boolean) => {
      const state = suggestionStateRef.current;
      if (state[kind] !== open) {
        state[kind] = open;
      }
      syncSuggestionDataset(editorRef.current, state);
    },
    [],
  );

  const suppressNextInput = useCallback(() => {
    suppressNextInputRef.current = true;
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      suppressNextInputRef.current = false;
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus,
      getElement: () => editorRef.current,
      getValue: () => {
        const editor = editorRef.current;
        return editor ? serializeEditor(editor) : value;
      },
      tryGetSelectionRange: () => {
        const editor = editorRef.current;
        return editor ? tryGetSelectionRange(editor) : null;
      },
      getSelectionRange: () => {
        const editor = editorRef.current;
        return editor ? getSelectionRange(editor) : { start: 0, end: 0 };
      },
      setSelectionRange: (start: number, end: number) => {
        const editor = editorRef.current;
        if (!editor) return;
        setSelectionRange(editor, start, end);
      },
      getCaretViewportRect: () => {
        const editor = editorRef.current;
        if (!editor) return { left: 0, top: 0, bottom: 0, height: 0 };
        return getContentEditableCaretViewportRect(editor);
      },
      setSuggestionOpen,
      suppressNextInput,
    }),
    [focus, setSuggestionOpen, suppressNextInput, value],
  );

  useLayoutEffect(() => {
    const next = value ?? "";
    const editor = editorRef.current;
    const focused = Boolean(editor && editor.contains(document.activeElement));
    const composing = isComposingRef.current;

    // 聚焦/输入法过程中：
    // - 若 value 与 DOM 当前一致：说明是用户输入导致的状态同步，不要让 React 重新渲染内容（避免 contentEditable 双写）。
    // - 若不一致：说明是外部程序性更新（例如插入 token / 删除 token），需要强制重建 DOM。
    if (focused || composing) {
      if (next === domValueRef.current) return;
      domValueRef.current = next;
      domDivergedRef.current = false;
      setRenderValue(next);
      setRenderEpoch((prev) => prev + 1);
      return;
    }

    // 失焦后同步：把 DOM 重新交回 React 控制，避免积累不一致状态
    domValueRef.current = next;
    setRenderValue((prev) => (prev === next ? prev : next));
    if (domDivergedRef.current) {
      domDivergedRef.current = false;
      setRenderEpoch((prev) => prev + 1);
    }
  }, [value]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    setSelectionRange(editor, pending.start, pending.end);
  }, [value]);

  const handleCompositionStart = useCallback(
    (event: CompositionEvent<HTMLDivElement>) => {
      isComposingRef.current = true;
      setComposingActive(true);
      // 标记卫生：新组合开始即作废上次未消费的「待补换行」（该次 Shift+Enter 被 IME
      // 忽略且 compositionend 未发生时，标记不得泄漏到下一次组合的上屏）。
      pendingNewlineAfterCompositionRef.current = false;
      if (onCompositionStart !== null && onCompositionStart !== undefined) {
        onCompositionStart(event);
      }
    },
    [onCompositionStart],
  );

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLDivElement>) => {
      isComposingRef.current = false;
      setComposingActive(false);
      const insertPendingNewline =
        pendingNewlineAfterCompositionRef.current &&
        !readOnly &&
        !event.defaultPrevented;
      pendingNewlineAfterCompositionRef.current = false;
      // 兼容中文输入法：部分环境下 compositionend 后的 input 仍可能被标记为 insertCompositionText，
      // 导致 onInput 不触发 applyChangeFromDom，从而 domValueRef 仍停留在旧值。
      // 若父组件在 onCompositionEnd 中读取 DOM 并同步 value（本仓库即如此），
      // 这里先把 domValueRef 对齐到当前 DOM，避免被误判为“外部程序性更新”而重建 DOM 造成失焦。
      const editor = editorRef.current;
      if (editor) {
        domValueRef.current = serializeEditor(editor);
      }
      // 组合结束必须同步受控 value：组合期间的 input 被有意忽略（避免半截拼音污染 token 解析），
      // 上屏后若不在此补发 onChange，消费方的 value 会停留在组合前——
      // 表现为占位文案与已上屏文本共存、字数计数为 0、PromptDock 提交空 prompt。
      if (!readOnly && !event.defaultPrevented) {
        applyChangeFromDom();
        // 组合期 Shift+Enter 的一次完成：先让 IME 上屏，紧接着自动补插入换行
        if (insertPendingNewline && editor) {
          insertNewline(editor);
        }
      }
      if (onCompositionEnd !== null && onCompositionEnd !== undefined) {
        onCompositionEnd(event);
      }
    },
    [applyChangeFromDom, insertNewline, onCompositionEnd, readOnly],
  );

  const handleInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      if (onInput !== null && onInput !== undefined) {
        onInput(event);
      }
      if (event.defaultPrevented) return;
      if (readOnly) return;
      if (suppressNextInputRef.current) {
        suppressNextInputRef.current = false;
        return;
      }
      const native = event.nativeEvent as InputEvent | undefined;
      if (
        isComposingRef.current ||
        (native !== null && native !== undefined ? native.isComposing : undefined) ||
        (native !== null && native !== undefined ? native.inputType : undefined) === "insertCompositionText"
      ) {
        return;
      }
      applyChangeFromDom();
    },
    [applyChangeFromDom, onInput, readOnly],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (onKeyDown !== null && onKeyDown !== undefined) {
        onKeyDown(event);
      }
      if (event.defaultPrevented) return;
      if (readOnly) return;

      // 关键：阻止编辑器内的 keydown 冒泡到画布/ReactFlow，避免触发选区变化导致“退出编辑”
      // - IME/全角符号场景下，不同输入法/浏览器对 key 的表现并不稳定（例如 Shift/Space/Process 等）
      // - 为了稳住编辑态：只要不是 Ctrl/Cmd/Alt 组合键，就一律阻止冒泡（但不阻止默认输入行为）
      if (!(event.metaKey || event.ctrlKey || event.altKey)) {
        event.stopPropagation();
      }

      const editor = editorRef.current;
      if (!editor) return;

      if (event.key === "Enter") {
        const nativeEvent = event.nativeEvent;
        // 残留组合态自愈：compositionend 丢失（如组合期间表面 DOM 被重建）会让
        // isComposingRef 永久卡在 true，之后所有 Enter 都被「让位 IME」分支吞掉。
        // keydown 自身携带的组合标记是更可靠的事实源：ref 为真但本次 keydown 干净
        // （isComposing=false 且非 keyCode 229）时，按非组合态正常处理。
        if (
          isComposingRef.current &&
          !nativeEvent.isComposing &&
          nativeEvent.keyCode !== 229
        ) {
          isComposingRef.current = false;
          setComposingActive(false);
        }
        const composing = isComposingRef.current || nativeEvent.isComposing;

        if (composing) {
          // 组合中的回车属于 IME（上屏/确认候选词），不换行不提交，也不拦截。
          // Shift+Enter 的换行意图挂起为「待补换行」：compositionend 上屏后自动补插
          // （一次完成：先让 IME 上屏，紧接着补换行）；普通 Enter 不挂起（行为不变）。
          if (event.shiftKey) {
            pendingNewlineAfterCompositionRef.current = true;
          }
          return;
        }

        const suggestionOpen =
          suggestionStateRef.current.pp ||
          suggestionStateRef.current.mention ||
          hasSuggestionOpen(editor);
        if (suggestionOpen && !event.shiftKey) {
          // 候选弹层打开时 Enter 是选中候选，让位弹层（避免在此改动 DOM）。
          // Shift+Enter 例外：换行意图优先于选候选，落回主路径插换行——
          // 含候选列表为空的情形，换行不得被静默吞掉。
          event.preventDefault();
          return;
        }

        event.preventDefault();
        // 通过 DOM 就地插入换行并走 applyChangeFromDom：
        // - 避免 value 同步时被误判为“外部程序性更新”导致重建 DOM -> 失焦 -> ReactFlow 瞬时空选择 -> 退出编辑
        // - 插入后补派发冒泡 input，让候选弹层重新对齐触发上下文（换行应终止 /、@ 匹配）
        insertNewline(editor);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        const current = serializeEditor(editor);
        const selection = getSelectionRange(editor);
        if (selection.start !== selection.end) return;
        const cursor = selection.start;
        const direction = event.key === "Backspace" ? "before" : "after";
        const token = findBoundaryToken(current, cursor, direction);
        if (!token) return;

        event.preventDefault();
        const { next, cursor: nextCursor } = removeTokenRange(current, token);
        pendingSelectionRef.current = { start: nextCursor, end: nextCursor };
        onChange(next);
        requestAnimationFrame(() => {
          if (editorRef.current !== null && editorRef.current !== undefined) {
            editorRef.current.focus();
          }
        });
      }
    },
    [insertNewline, onChange, onKeyDown, readOnly],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (onPaste !== null && onPaste !== undefined) {
        onPaste(event);
      }
      if (event.defaultPrevented) return;
      if (readOnly) return;
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      const selection = window.getSelection();
      const editor = editorRef.current;
      if (!selection || selection.rangeCount < 1 || !editor) return;
      const range = selection.getRangeAt(0);
      if (
        !editor.contains(range.startContainer) &&
        range.startContainer !== editor
      )
        return;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      applyChangeFromDom();
    },
    [applyChangeFromDom, onPaste, readOnly],
  );

  const handleRemoveToken = useCallback(
    (token: TokenSegment) => {
      if (readOnly) return;
      const editor = editorRef.current;
      const current = editor ? serializeEditor(editor) : (value ?? "");
      const { next, cursor } = removeTokenRange(current, token);
      pendingSelectionRef.current = { start: cursor, end: cursor };
      onChange(next);
      requestAnimationFrame(() => editorRef.current !== null && editorRef.current !== undefined ? editorRef.current.focus() : undefined);
    },
    [onChange, readOnly, value],
  );

  return (
    <div className={cn("relative", containerClassName)}>
      {/* 组合输入进行中也要隐藏占位（对齐原生 placeholder 行为），避免拼音预编辑文本与占位文案重叠 */}
      {placeholder && !value && !composingActive ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 select-none px-3 py-2 text-base text-muted-foreground md:text-sm",
            className,
          )}
        >
          {placeholder}
        </div>
      ) : null}
      {promptLimit ? (
        <div
          className={cn(
            "pointer-events-none absolute right-2 bottom-1 z-20 select-none text-[10px] tabular-nums",
            promptLimit.current > promptLimit.max
              ? "font-medium text-destructive"
              : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {promptLimit.current}/{promptLimit.max}
        </div>
      ) : null}
      <div
        key={renderEpoch}
        ref={editorRef}
        role={isTextEditable ? "textbox" : undefined}
        aria-multiline={isTextEditable ? "true" : undefined}
        aria-readonly={isTextEditable ? false : undefined}
        tabIndex={isTextEditable ? 0 : -1}
        contentEditable={isTextEditable}
        data-canvas-selection-edit-session={isTextEditable ? "true" : undefined}
        suppressContentEditableWarning
        className={cn(
          "min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs",
          "outline-none transition-[color,box-shadow]",
          "focus-visible:ring-1 focus-visible:ring-ring",
          "whitespace-pre-wrap break-words",
          readOnly && "cursor-not-allowed opacity-50",
          className,
        )}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        {...props}
      >
        {segments.map((seg) => {
          if (seg.kind === "text") return seg.text;
          if (seg.tokenType === "asset") {
            // 未提供 mentionDisplay 的编辑面不提供 @ 能力：token 按字面量渲染，不转 chip
            if (mentionDisplay === null || mentionDisplay === undefined) {
              return `[[@asset:${seg.assetId}]]`;
            }
            const display = mentionDisplay.get(seg.assetId);
            const invalid = display === undefined;
            const chipText = display !== undefined ? `@${display.label}` : "@已失效引用";
            const assetTooltip = invalid
              ? "该素材引用已失效（素材已从画布移除或已删除），可删除后重新 @"
              : `引用画布上的素材 ${display.label}`;
            return (
              <Tooltip key={`asset:${seg.assetId}:${seg.start}`}>
                <TooltipTrigger asChild>
                  <span
                    data-asset-id={seg.assetId}
                    contentEditable={false}
                    role={isTextEditable ? "button" : undefined}
                    tabIndex={isTextEditable ? 0 : -1}
                    className={cn(
                      "mx-0.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs align-baseline",
                      invalid
                        ? "bg-destructive/10 text-destructive line-through decoration-destructive/60"
                        : "bg-accent text-accent-foreground",
                    )}
                    onMouseDown={(e) => {
                      if (!isTextEditable) return;
                      // 避免点击 token 导致 focus 丢失
                      e.preventDefault();
                    }}
                    onClick={() => {
                      if (!isTextEditable) return;
                      // 点击 token 本体：把光标放到 token 之后（便于继续输入）
                      const surface = editorRef.current;
                      if (!surface) return;
                      const cursor = seg.end;
                      requestAnimationFrame(() => {
                        surface.focus();
                        setSelectionRange(surface, cursor, cursor);
                      });
                    }}
                    onKeyDown={(e) => {
                      if (!isTextEditable) return;
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      const surface = editorRef.current;
                      if (!surface) return;
                      const cursor = seg.end;
                      requestAnimationFrame(() => {
                        surface.focus();
                        setSelectionRange(surface, cursor, cursor);
                      });
                    }}
                  >
                    <span className="font-mono">{chipText}</span>
                    {isTextEditable ? (
                      <button
                        type="button"
                        aria-label={`移除素材引用：${chipText}`}
                        className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRemoveToken(seg);
                        }}
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  className="max-w-[360px] whitespace-pre-wrap break-words"
                  sideOffset={6}
                >
                  {assetTooltip}
                </TooltipContent>
              </Tooltip>
            );
          }
          const snapshot = (promptPresetSnapshots !== null && promptPresetSnapshots !== undefined ? promptPresetSnapshots[seg.presetId] : undefined);
          const presetInvalid = snapshot === undefined || snapshot.content.length === 0;
          const name = (snapshot !== null && snapshot !== undefined ? snapshot.name : undefined) || "预设";
          const snapshotContent = snapshot !== null && snapshot !== undefined ? snapshot.content : undefined;
          const tooltip = presetInvalid
            ? `该预设引用已失效（找不到这次的预设内容），可删除后重新 / 插入`
            : truncateTooltip(snapshotContent ?? '');

          return (
            <Tooltip key={`${seg.presetId}:${seg.start}`}>
              <TooltipTrigger asChild>
                <span
                  data-pp-id={seg.presetId}
                  contentEditable={false}
                  role={isTextEditable ? "button" : undefined}
                  tabIndex={isTextEditable ? 0 : -1}
                  className={cn(
                    "mx-0.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs align-baseline",
                    presetInvalid
                      ? "bg-destructive/10 text-destructive line-through decoration-destructive/60"
                      : "bg-muted text-foreground",
                  )}
                  onMouseDown={(e) => {
                    if (!isTextEditable) return;
                    // 避免点击 token 导致 focus 丢失
                    e.preventDefault();
                  }}
                  onClick={() => {
                    if (!isTextEditable) return;
                    // 点击 token 本体：把光标放到 token 之后（便于继续输入）
                    const surface = editorRef.current;
                    if (!surface) return;
                    const cursor = seg.end;
                    requestAnimationFrame(() => {
                      surface.focus();
                      setSelectionRange(surface, cursor, cursor);
                    });
                  }}
                  onKeyDown={(e) => {
                    if (!isTextEditable) return;
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    const surface = editorRef.current;
                    if (!surface) return;
                    const cursor = seg.end;
                    requestAnimationFrame(() => {
                      surface.focus();
                      setSelectionRange(surface, cursor, cursor);
                    });
                  }}
                >
                  <span className="font-mono">[{name}</span>
                  {isTextEditable ? (
                    <button
                      type="button"
                      aria-label={`移除提示词预设：${name}`}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleRemoveToken(seg);
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                  <span className="font-mono">]</span>
                </span>
              </TooltipTrigger>
              <TooltipContent
                className="max-w-[360px] whitespace-pre-wrap break-words"
                sideOffset={6}
              >
                {tooltip}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});

PromptPresetTokenEditor.displayName = "PromptPresetTokenEditor";
