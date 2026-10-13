"use client";

import { memo, useMemo, useCallback, useState, useEffect, useRef, type PointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { type NodeProps } from "@xyflow/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContentNodeCard } from "./ContentNodeCard";
import { cn } from "@/lib/utils";
import { getRuntimeProjectPath } from "@/client/store/runtimeStore";
import { useCanvasStore } from "../../store/canvasStore";
import { useExecutionStore } from "../../store/executionStore";
import type { PromptCollectionItem, TextInputNodeData, TextInputSegment, NodeTaskInfo } from "../../types";
import { composeEnhancedTextInput, createLocalTextSegment, prunePromptPresetSnapshots } from "../../nodes/textInput/enhancedTextNode";
import { TextInputNodeToolbar } from "./TextInputNodeToolbar";
import { TextInputAiEditDialog } from "../dialogs/TextInputAiEditDialog";
import { TextInputExpandEditDialog } from "../dialogs/TextInputExpandEditDialog";
import { buildTextInputAiEditModelOptions } from "../../services/textInputAiEditModelOptions";
import { usePromptDockStore } from "@/features/promptdock/promptDockStore";
import { TaskStatusBadge } from "./shared/TaskStatusBadge";
import { getTaskStatusOverlayText } from "../../utils/taskStatusMeta";
import { resolveTaskFailurePresentation } from "../../utils/taskFailurePresentation";
import { snapshotPromptTextSurface } from "../../utils/promptTextSurfaceSelection";
import { revealTaskArchive } from "@iart/backend-sdk/electron-bridge";
import { PromptPresetSlashPopover } from "./shared/PromptPresetSlashPopover";
import { PromptMentionPopover } from "./shared/PromptMentionPopover";
import { useTextNodeMentionContext } from "./shared/useTextNodeMentionContext";
import type { AssetMentionCandidate } from "../../engine/promptAssetMentions";
import { PromptPresetTokenEditor, type PromptTextSurface } from "./shared/PromptPresetTokenEditor";
import { resolveFallbackGraphNodeFromNodePropsData, useNodeFromStore } from "../../hooks/useNodeFromStore";



const EMPTY_SEGMENTS: TextInputSegment[] = [];

type FlushSimpleTextDraftOptions = {
  syncDraftState: boolean | undefined;
};

export const TextInputNode = memo(function TextInputNode({ id, selected, data }: NodeProps) {
  const fallback = useMemo(
    () =>
      resolveFallbackGraphNodeFromNodePropsData<TextInputNodeData>({
        nodeId: id,
        type: "textInput",
        nodePropsData: data,
      }),
    [id, data],
  );
  const {
    data: nodeData,
  } = useNodeFromStore<TextInputNodeData>({
    nodeId: id,
    fallback,
    select: (snapshot) => snapshot,
    equalityFn: () => undefined,
  });
  const isNodeSelectedInStore = useCanvasStore((state) => state.selectedNodeIds.includes(id));
  const isSoloSelectedInStore = useCanvasStore(
    (state) => state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === id,
  );
  const selectedNodeCountInStore = useCanvasStore(
    (state) => state.selectedNodeIds.length,
  );
  const toolbarVisible =
    selectedNodeCountInStore === 0 ? Boolean(selected) : isSoloSelectedInStore;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [expandDialogOpen, setExpandDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const editorSurfaceRef = useRef<PromptTextSurface | null>(null);
  const expandEditorRef = useRef<PromptTextSurface | null>(null);
  const expandSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const composingRef = useRef(false);
  const imeGraceUntilRef = useRef(0);
  const pendingDeselectTimerRef = useRef<number | null>(null);
  const committedTextRef = useRef("");
  const flushSimpleTextDraftRef = useRef<(options: FlushSimpleTextDraftOptions | undefined) => void>(() => undefined);
  const nodeIdRef = useRef(id);
  nodeIdRef.current = id;
  const imeGraceMs = 400;
  // 拖拽检测：区分点击和拖拽
  const pointerStateRef = useRef<{ x: number; y: number; moved: boolean; wasSelected: boolean } | null>(null);

  const segments = ((nodeData !== null && nodeData !== undefined ? (nodeData as TextInputNodeData).segments : undefined) ?? EMPTY_SEGMENTS) as TextInputSegment[];
  const isSimpleSingleLocal = segments.length === 1 && (segments[0] !== null && segments[0] !== undefined ? segments[0].kind : undefined) === "local";
  const simpleLocal = isSimpleSingleLocal ? (segments[0] as Extract<TextInputSegment, { kind: "local" }>) : null;
  const simpleText = isSimpleSingleLocal ? ((simpleLocal !== null && simpleLocal !== undefined ? simpleLocal.text : undefined) ?? "") : "";
  const [draftText, setDraftText] = useState(() => simpleText);
  const draftTextRef = useRef(simpleText);
  const setDraftTextSnapshot = useCallback((next: string) => {
    draftTextRef.current = next;
    setDraftText(next);
  }, []);

  useEffect(() => {
    if (isNodeSelectedInStore) {
      if (pendingDeselectTimerRef.current !== null) {
        window.clearTimeout(pendingDeselectTimerRef.current);
        pendingDeselectTimerRef.current = null;
      }
      return;
    }

    if (!isEditing) return;

    if (pendingDeselectTimerRef.current !== null) {
      window.clearTimeout(pendingDeselectTimerRef.current);
      pendingDeselectTimerRef.current = null;
    }

    // B：输入法/全角符号在 ReactFlow 内部可能触发一次瞬时 deselect（肉眼几乎不可见），
    // 但会导致本地 isEditing 被“永久关掉”。这里做延迟 + 二次确认：
    // - 若很快又选回（selected=true）则不退出编辑
    // - 若仍然聚焦在编辑器/仍处于输入法 composing，则不退出编辑（避免“节点还选中但编辑态没了”）
    const delayMs = 200;

    const scheduleRecheck = (waitMs: number) => {
      pendingDeselectTimerRef.current = window.setTimeout(() => {
        pendingDeselectTimerRef.current = null;

        if (useCanvasStore.getState().selectedNodeIds.includes(id)) return;

        const element = editorSurfaceRef.current !== null && editorSurfaceRef.current !== undefined ? editorSurfaceRef.current.getElement() : undefined;
        const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
        const isFocused = Boolean(element && active && element.contains(active));

        // composing / grace window：延迟再判断，避免 IME/ReactFlow 抖动把编辑态关掉
        if (composingRef.current) {
          scheduleRecheck(50);
          return;
        }
        const graceRemaining = imeGraceUntilRef.current - Date.now();
        if (graceRemaining > 0) {
          scheduleRecheck(Math.max(0, graceRemaining));
          return;
        }

        // 仍聚焦：继续观察（避免焦点瞬态导致误判）
        if (isFocused) {
          scheduleRecheck(120);
          return;
        }

        setIsEditing(false);
      }, waitMs);
    };

    scheduleRecheck(delayMs);

    return () => {
      if (pendingDeselectTimerRef.current !== null) {
        window.clearTimeout(pendingDeselectTimerRef.current);
        pendingDeselectTimerRef.current = null;
      }
    };
  }, [id, isEditing, isNodeSelectedInStore]);

  // 外部数据变更（例如撤销/重做/脚本修改）时同步到本地草稿，但不打断正在输入的光标/输入法状态
  useEffect(() => {
    if (!isSimpleSingleLocal) return;
    const element = editorSurfaceRef.current !== null && editorSurfaceRef.current !== undefined ? editorSurfaceRef.current.getElement() : undefined;
    const isFocused = element ? element.contains(document.activeElement) : false;
    if (isFocused || composingRef.current) return;
    committedTextRef.current = simpleText;
    setDraftTextSnapshot(simpleText);
  }, [isSimpleSingleLocal, setDraftTextSnapshot, simpleText]);

  const taskInfo = useMemo(() => {
    const dataSource = (nodeData ?? null) as TextInputNodeData | null;
    return (dataSource !== null && dataSource !== undefined ? (dataSource as { taskInfo: NodeTaskInfo | undefined }).taskInfo : undefined) ?? null;
  }, [nodeData]);

  const nodeDiagnosticInfo = useExecutionStore((state) => state.getNodeDiagnosticInfo(id, undefined));
  const backendMessageText = (nodeDiagnosticInfo !== null && nodeDiagnosticInfo !== undefined ? nodeDiagnosticInfo.backendMessage : undefined);
  const failurePresentation = resolveTaskFailurePresentation({ taskInfo, backendMessage: backendMessageText, fallback: undefined });
  const taskArchiveTaskId = (taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined);

  const handleOpenTaskArchive = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!taskArchiveTaskId) {
        toast.warning("这次任务还没有日志，暂时打不开");
        return;
      }
      const result = await revealTaskArchive(taskArchiveTaskId, getRuntimeProjectPath());
      if (result.ok) {
        toast.success("已打开任务文件夹");
        return;
      }
      if (result.reason === "not-found") {
        toast.error("这次任务的日志文件找不到了");
        return;
      }
      if (result.reason === "missing-project-path") {
        toast.error("无法定位项目里的日志文件夹");
        return;
      }
      toast.error("打开任务文件夹失败，请稍后重试");
    },
    [taskArchiveTaskId],
  );

  const taskStatus = taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined;
  const overlayStatusText = getTaskStatusOverlayText(taskStatus, (taskInfo !== null && taskInfo !== undefined && taskInfo.progress !== null && taskInfo.progress !== undefined ? taskInfo.progress.phase : undefined) as string | undefined);
  const editingLocked = Boolean(overlayStatusText);

  const overlayBadges = taskStatus !== undefined ? (
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col gap-1">
      <TaskStatusBadge
        status={taskStatus}
        className={undefined}
        compact={undefined}
        labelOverride={undefined}
        onActivate={undefined}
        ariaLabel={undefined}
      />
    </div>
  ) : null;

  const statusOverlay = overlayStatusText ? (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="flex items-center gap-2 rounded-md bg-black/55 px-3 py-1.5 text-xs text-white">
        <span className="h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
        <span>{overlayStatusText}</span>
      </div>
    </div>
  ) : (taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) === "failed" ? (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-md bg-black/70 px-3 py-2 text-xs text-white">
      <div className="pointer-events-auto select-text break-words whitespace-pre-wrap">{(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.summary : undefined) ?? "生成失败"}</div>
      {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) || (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined) ? (
        <details className="pointer-events-auto mt-1">
          <summary className="cursor-pointer select-none text-[10px] text-white/80">详情</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-white/90">{failurePresentation !== null ? failurePresentation.backendMessage ?? failurePresentation.rawDetailText : undefined}</pre>
        </details>
      ) : null}
      {taskArchiveTaskId ? (
        <Button type="button" size="sm" variant="secondary" className="pointer-events-auto mt-2 h-7 px-2" onClick={handleOpenTaskArchive}>
          打开任务文件夹
        </Button>
      ) : null}
    </div>
  ) : null;

  const previewText = useMemo(() => composeEnhancedTextInput({ data: nodeData as TextInputNodeData, options: undefined }), [nodeData]);

  // @ 上下文（spec：prompt内联交互）：输出连到 @ 能力模型 prompt 输入时，
  // 本节点编辑面身份等价于该模型节点的 Inspector prompt 输入；
  // 前提不满足时 mentionDisplay 为空表，已有 [[@asset:]] token 渲染失效态。
  const {
    mentionEnabled,
    candidates: mentionCandidates,
    mentionDisplay,
  } = useTextNodeMentionContext(id);

  const currentPromptPresetSnapshots = nodeData !== null && nodeData !== undefined
    ? (nodeData as TextInputNodeData).promptPresetSnapshots
    : undefined;

  // 程序化建边交互：消费一次性编辑请求（旧「资产落定即连模型节点」随模型节点移除，
  // 文本素材只作为 PromptDock 可引用的输入，不再建边）
  const pendingTextEditNodeId = useCanvasStore((state) => state.pendingTextEditNodeId);
  const clearNodeTextEditRequest = useCanvasStore((state) => state.clearNodeTextEditRequest);

  useEffect(() => {
    if (pendingTextEditNodeId !== id) return;
    // 不满足编辑前置条件时清空 request，避免悬挂
    if (!isSimpleSingleLocal || editingLocked) {
      clearNodeTextEditRequest();
      return;
    }
    setIsEditing(true);
    requestAnimationFrame(() => {
      editorSurfaceRef.current?.focus();
      clearNodeTextEditRequest();
    });
  }, [pendingTextEditNodeId, id, isSimpleSingleLocal, editingLocked, clearNodeTextEditRequest]);

  const commitSimpleText = useCallback(
    (text: string, options: { presetSnapshot: PromptCollectionItem | undefined } | undefined) => {
      if (!simpleLocal) return;
      const presetSnapshot = options !== null && options !== undefined ? options.presetSnapshot : undefined;
      if (committedTextRef.current === text && !presetSnapshot) return;
      committedTextRef.current = text;
      const nextSegments: TextInputSegment[] = [{ ...simpleLocal, text }];
      const baseSnapshots = currentPromptPresetSnapshots ?? undefined;
      const mergedSnapshots: Record<string, PromptCollectionItem> | undefined =
        presetSnapshot !== undefined ? { ...(baseSnapshots ?? {}), [presetSnapshot.id]: presetSnapshot } : baseSnapshots;
      const nextPromptPresetSnapshots = prunePromptPresetSnapshots({
        segments: nextSegments,
        promptPresetSnapshots: mergedSnapshots ?? undefined,
      });
      updateNodeData(id, {
        segments: nextSegments,
        ...(nextPromptPresetSnapshots
          ? { promptPresetSnapshots: nextPromptPresetSnapshots }
          : {}),
      }, undefined);
      // 快速提示词落定即连到模型节点的旧生成链已随模型节点移除；
      // 文本素材内容只作为可被 PromptDock 引用的输入，不再建边或刷新端口。
    },
    [currentPromptPresetSnapshots, id, simpleLocal, updateNodeData],
  );

  const flushSimpleTextDraft = useCallback(
    (surfaceRef: RefObject<PromptTextSurface | null> | undefined, options: FlushSimpleTextDraftOptions | undefined) => {
      if (!simpleLocal || composingRef.current) return false;
      const next = ((surfaceRef !== null && surfaceRef !== undefined && surfaceRef.current !== null && surfaceRef.current !== undefined ? surfaceRef.current.getValue() : undefined) ?? draftTextRef.current);
      draftTextRef.current = next;
      if ((options !== null && options !== undefined ? options.syncDraftState : undefined) !== false) {
        setDraftText(next);
      }
      commitSimpleText(next, undefined);
      return true;
    },
    [commitSimpleText, simpleLocal],
  );

  flushSimpleTextDraftRef.current = (options: FlushSimpleTextDraftOptions | undefined) => {
    flushSimpleTextDraft(undefined, options);
  };

  useEffect(() => {
    if (!editingLocked) return;
    flushSimpleTextDraft(undefined, undefined);
    setIsEditing(false);
    setAiDialogOpen(false);
    setExpandDialogOpen(false);
  }, [editingLocked, flushSimpleTextDraft]);

  useEffect(() => {
    return () => {
      flushSimpleTextDraftRef.current({ syncDraftState: false });
    };
  }, []);

  const handleSimpleTextChange = useCallback(
    (next: string) => {
      setDraftTextSnapshot(next);
    },
    [setDraftTextSnapshot],
  );

  const handleInsertWithPreset = useCallback(
    (nextValue: string, preset: PromptCollectionItem) => {
      setDraftTextSnapshot(nextValue);
      commitSimpleText(nextValue, { presetSnapshot: preset });
    },
    [commitSimpleText, setDraftTextSnapshot],
  );

  const handleInsertPresetPayload = useCallback(
    ({ nextValue, preset }: { nextValue: string; preset: PromptCollectionItem }) => {
      handleInsertWithPreset(nextValue, preset);
    },
    [handleInsertWithPreset],
  );

  // @ 选中素材：token 插入只改文本（锚点身份绑定 assetId，无快照类附属数据）
  const handleMentionInsert = useCallback(
    ({ nextValue }: { nextValue: string; candidate: AssetMentionCandidate }) => {
      setDraftTextSnapshot(nextValue);
      commitSimpleText(nextValue, undefined);
    },
    [commitSimpleText, setDraftTextSnapshot],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    imeGraceUntilRef.current = Date.now() + imeGraceMs;
  }, [imeGraceMs]);

  const handleSurfaceCompositionEnd = useCallback(
    (surfaceRef: RefObject<PromptTextSurface | null>) => {
      composingRef.current = false;
      imeGraceUntilRef.current = Date.now() + imeGraceMs;
      flushSimpleTextDraft(surfaceRef, undefined);
    },
    [flushSimpleTextDraft, imeGraceMs],
  );

  const handleSurfaceBlur = useCallback(
    (surfaceRef: RefObject<PromptTextSurface | null>) => {
      flushSimpleTextDraft(surfaceRef, undefined);
    },
    [flushSimpleTextDraft],
  );

  const handleInlineCompositionEnd = useCallback(() => handleSurfaceCompositionEnd(editorSurfaceRef), [handleSurfaceCompositionEnd]);

  const handleExpandCompositionEnd = useCallback(() => handleSurfaceCompositionEnd(expandEditorRef), [handleSurfaceCompositionEnd]);

  const handleInlineBlur = useCallback(() => handleSurfaceBlur(editorSurfaceRef), [handleSurfaceBlur]);

  const handleExpandBlur = useCallback(() => handleSurfaceBlur(expandEditorRef), [handleSurfaceBlur]);

  // 编辑模式下阻止事件冒泡，让 textarea 正常工作
  const handleTextareaPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // 编辑模式：阻止冒泡，让 textarea 正常工作
    event.stopPropagation();
  }, []);

  // 覆盖层的 Pointer 事件处理（非编辑模式）
  const handleOverlayPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // 记录起始位置，不阻止任何事件，让 React Flow 处理拖拽
      pointerStateRef.current = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        // 用 store 的“实时选择态”做判定，并固化到 pointerdown（避免同一次点击里选中态变化导致变成“一次点击就进入编辑”）
        wasSelected: Boolean(selected),
      };
    },
    [selected],
  );

  const handleOverlayPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const state = pointerStateRef.current;
    if (!state || state.moved) return;

    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    // 移动超过 3px 判定为拖拽
    if (dx * dx + dy * dy > 9) {
      state.moved = true;
    }
  }, []);

  const handleOverlayPointerUp = useCallback(
    (_event: PointerEvent<HTMLDivElement>) => {
      const state = pointerStateRef.current;
      if (!state) return;

      const wasDragging = state.moved;
      const wasSelected = state.wasSelected;
      pointerStateRef.current = null;

      if (wasDragging) {
        return;
      }

      if (!wasSelected) {
        return;
      }

      // 如果没有拖拽且节点已选中，进入编辑模式
      if (!editingLocked) {
        setIsEditing(true);
        setTimeout(() => editorSurfaceRef.current !== null && editorSurfaceRef.current !== undefined ? editorSurfaceRef.current.focus() : undefined, 0);
      }
    },
    [editingLocked],
  );

  const handleOpenExpandEdit = useCallback(() => {
    if (!isSimpleSingleLocal || editingLocked) return;
    const { selection } = snapshotPromptTextSurface(editorSurfaceRef.current, draftText);
    expandSelectionRef.current = selection;
    setExpandDialogOpen(true);
  }, [draftText, editingLocked, isSimpleSingleLocal]);

  const sourceTextForAi = isSimpleSingleLocal ? draftText : previewText;

  /* AI 编辑的模型候选取自对话模型目录（用户在主窗口自己添加的对话模型），与 PromptDock 的
     agent 服务行同源。订阅 store 而不是挂载时算一次：目录是异步装载的，算一次会把
     「装载完成前渲染」的节点永久钉在空候选上。 */
  const chatModelCatalog = usePromptDockStore((s) => s.chatCatalog);
  const aiEditModelOptions = useMemo(
    () => buildTextInputAiEditModelOptions(chatModelCatalog),
    [chatModelCatalog],
  );

  const applyAiResultToNode = useCallback(
    (nextText: string) => {
      const normalized = nextText ?? "";
      if (!normalized.trim()) return;

      let replacedFirstLocal = false;
      const nextSegments: TextInputSegment[] = segments.map((seg) => {
        if (seg.kind === "local" && !replacedFirstLocal) {
          replacedFirstLocal = true;
          return { ...seg, enabled: true, text: normalized };
        }
        return { ...seg, enabled: false } as TextInputSegment;
      });

      if (!replacedFirstLocal) {
        nextSegments.unshift(createLocalTextSegment(normalized));
      }

      updateNodeData(id, { segments: nextSegments }, undefined);

      if (isSimpleSingleLocal) {
        committedTextRef.current = normalized;
        setDraftTextSnapshot(normalized);
      }
    },
    [id, isSimpleSingleLocal, segments, setDraftTextSnapshot, updateNodeData],
  );

  return (
    <ContentNodeCard nodeId={id} selected={selected} minWidth={180} minHeight={120} fill overlay={undefined} contentRenderPolicy={undefined} identityHint={undefined} identityPlaceholder={undefined} width={undefined} noPadding={undefined} className={undefined}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {overlayBadges}
        {isSimpleSingleLocal ? (
          <PromptPresetTokenEditor
            ref={editorSurfaceRef}
            value={draftText}
            onChange={handleSimpleTextChange}
            promptPresetSnapshots={(nodeData !== null && nodeData !== undefined ? (nodeData as TextInputNodeData).promptPresetSnapshots : undefined) ?? undefined}
            editingSessionActive={isEditing}
            containerClassName="flex-1 min-h-[72px] w-full"
            mentionDisplay={mentionDisplay}
            onPointerDown={isEditing ? handleTextareaPointerDown : undefined}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleInlineCompositionEnd}
            onBlur={handleInlineBlur}
            readOnly={editingLocked}
            placeholder={"输入文本..."}
            className={cn(
              "h-full w-full overflow-y-auto border-none bg-transparent px-0 py-2 text-sm leading-relaxed shadow-none",
              "focus-visible:border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-none",
              "placeholder:text-muted-foreground",
              !isEditing && (editingLocked ? "cursor-not-allowed" : "cursor-default"),
              // 只在编辑模式下阻止拖拽
              isEditing && "nodrag nopan",
            )}
          />
        ) : (
          <div
            aria-hidden="true"
            className={cn(
              "flex-1 min-h-[72px] w-full px-0 py-2 text-sm leading-relaxed",
              "whitespace-pre-wrap break-words",
              "pt-5 text-muted-foreground",
            )}
          >
            {previewText || "多段文本请在右侧面板编辑..."}
          </div>
        )}

        <PromptPresetSlashPopover surfaceRef={editorSurfaceRef} disabled={!isSimpleSingleLocal || editingLocked} onInsert={handleInsertPresetPayload} />
        {mentionEnabled ? (
          <PromptMentionPopover surfaceRef={editorSurfaceRef} candidates={mentionCandidates} disabled={!isSimpleSingleLocal || editingLocked} onInsert={handleMentionInsert} />
        ) : null}
        {/* 非编辑模式的透明覆盖层：允许拖拽穿透，点击进入编辑 */}
        {!isEditing && isSimpleSingleLocal && <div className={cn("absolute inset-0 z-10", editingLocked ? "cursor-not-allowed" : "cursor-default")} onPointerDown={handleOverlayPointerDown} onPointerMove={handleOverlayPointerMove} onPointerUp={handleOverlayPointerUp} />}
        {statusOverlay}
      </div>

      <TextInputNodeToolbar
        nodeId={id}
        disabled={editingLocked}
        visible={toolbarVisible}
        showExpandEdit={isSimpleSingleLocal}
        onExpandEditClick={handleOpenExpandEdit}
        onAiEditClick={() => setAiDialogOpen(true)}
      />

      <TextInputExpandEditDialog open={expandDialogOpen} onOpenChange={setExpandDialogOpen} value={draftText} editorRef={expandEditorRef} promptPresetSnapshots={(nodeData !== null && nodeData !== undefined ? (nodeData as TextInputNodeData).promptPresetSnapshots : undefined) ?? undefined} readOnly={editingLocked} initialSelection={expandSelectionRef.current} onChange={handleSimpleTextChange} onCompositionStart={handleCompositionStart} onCompositionEnd={handleExpandCompositionEnd} onBlur={handleExpandBlur} onInsertPreset={handleInsertPresetPayload} mentionEnabled={mentionEnabled} mentionCandidates={mentionCandidates} mentionDisplay={mentionDisplay} onInsertMention={handleMentionInsert} />

      <TextInputAiEditDialog open={aiDialogOpen} onOpenChange={setAiDialogOpen} sourceText={sourceTextForAi} onApply={applyAiResultToNode} enableTemplates modelOptions={aiEditModelOptions} />
    </ContentNodeCard>
  );
});

export default TextInputNode;
