"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useRef } from "react";

import { AppQuickControls } from "@/client/components/AppQuickControls";
import { NodeCanvas } from "./canvas/NodeCanvas";
import { CanvasToolbar } from "./toolbar/CanvasToolbar";
import { CanvasPreparationScreen } from "./CanvasPreparationScreen";
import { useAutoSave, useCanvasHotkeys } from "../hooks";
import { useCanvasLocateRequestListener } from "../hooks/useCanvasLocateRequest";
import { useCloseProtocol } from "../hooks/useCloseProtocol";
import { SaveCharacterDialog, CharacterLibraryDialog } from "./character";
import { useCanvasPreparationController } from "./canvas/useCanvasPreparationController";
import { PromptDock } from "@/features/promptdock/PromptDock";
import { RightWorkspace } from "@/features/rightworkspace/RightWorkspace";
import { PackageAreaToggleButton } from "@/features/rightworkspace/PackageAreaToggleButton";
import type { NodeSize } from "../types";

function CanvasRuntimeEffects() {
  useAutoSave();
  useCanvasHotkeys();
  useCloseProtocol();
  // 模块侧定位请求端点（远处出生的任务批次 toast「查看」动作经此转调统一定位抽象）
  useCanvasLocateRequestListener();
  return null;
}

export function CanvasEditor() {
  const {
    hubRuntime,
    released,
    phase,
    markStartupInteractiveReady,
    screenProps,
  } = useCanvasPreparationController();
  // NodeCanvas 启动收敛（spec：画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」
  // 「探针职责下放到 NodeCanvas」）。
  //
  // waiting-interactive 阶段：NodeCanvas 挂载到隐藏容器跑 readiness 自检（spec「探针职责下放到
  // NodeCanvas」）；通过 loadNodeGraph 完成时灌入 placeholderNodeIds（spec「启动期占位壳契约」），
  // 节点都以占位壳态轻量挂载（媒体子树 / 重计算子树 / 非必要 RO 不挂载），避免首帧完整子树挂载
  // 压满主线程导致 rAF 调度不到、readiness 卡死。
  //
  // released 阶段：旧 NodeCanvas 卸载、新 NodeCanvas 在 EditorShell 内挂载，因 placeholderNodeIds
  // 仍未被消费（启动期升级要等 preparationPhase==='ready' 才触发，见 useNodeCanvasViewportController），
  // 新 NodeCanvas 的节点也以占位壳态轻量挂载；新实例的 viewport controller 监听 preparationPhase==='ready'
  // 触发分帧升级，节点从占位壳态过渡到完整渲染态（spec「从占位壳状态过渡到完整渲染」）。
  //
  // 其余准备态（resolving / loading-project / connecting-sync / awaiting-recovery 等）只渲染准备界面。
  const isWaitingInteractive = phase === "waiting-interactive";

  // measured size ref holder：NodeCanvas 上抛 → CanvasToolbar 读取（兄弟组件桥接）
  const measuredSizeByNodeIdRef = useRef<Readonly<Record<string, NodeSize>>>({});
  const handleMeasuredSizeChange = useCallback((next: Readonly<Record<string, NodeSize>>) => {
    measuredSizeByNodeIdRef.current = next;
  }, []);

  // derived size ref holder：组节点派生尺寸（同 measured 桥接模式）
  const derivedSizeByNodeIdRef = useRef<Readonly<Record<string, NodeSize>>>({});
  const handleDerivedSizeChange = useCallback((next: Readonly<Record<string, NodeSize>>) => {
    derivedSizeByNodeIdRef.current = next;
  }, []);

  if (!hubRuntime) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          无法连接项目管理应用，画布暂时打不开。请先启动项目管理应用，再重新打开项目。
        </div>
      </div>
    );
  }

  if (!released) {
    return (
      <div className="relative flex h-full flex-col bg-background">
        {isWaitingInteractive ? (
          <div
            className="pointer-events-none absolute inset-0 opacity-0"
            aria-hidden="true"
            data-testid="canvas-startup-nodecanvas-hidden"
          >
            <ReactFlowProvider>
              <NodeCanvas markStartupInteractiveReady={markStartupInteractiveReady} />
            </ReactFlowProvider>
          </div>
        ) : null}
        <div className="absolute inset-0 z-10">
          <CanvasPreparationScreen {...screenProps} />
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="relative flex h-full flex-col bg-background">
        <CanvasRuntimeEffects />
        <div
          className="flex h-full flex-col bg-background"
          data-testid="editor-shell"
        >
          <CanvasToolbar
            rightSlot={
              <div className="flex items-center gap-2">
                <PackageAreaToggleButton />
                <AppQuickControls />
              </div>
            }
            measuredSizeByNodeIdRef={measuredSizeByNodeIdRef}
            derivedSizeByNodeIdRef={derivedSizeByNodeIdRef}
          />
          <div className="relative flex min-h-0 flex-1 overflow-hidden" style={{ minWidth: 600 }}>
            {/* PromptDock 挂载于画布容器内部（原型 composer-wrap 语义：Dock 属于画布，
                只占画布容器可用宽度，左右 16px 沟槽让画布交互，仅卡片可交互）。
                右侧工作区开合时本容器 flex 缩窄，Dock absolute 定位随容器自动缩窄回中，
                不设置窗口级定位（spec：Dock 是画布的一部分） */}
            <div className="relative h-full min-h-0 flex-1">
              <NodeCanvas onMeasuredSizeChange={handleMeasuredSizeChange} onDerivedSizeChange={handleDerivedSizeChange} />
              <PromptDock />
            </div>
            {/* 右侧工作区：唯一动态承载面，无内容时 width:0 完全收起 */}
            <RightWorkspace />
          </div>
        </div>
      </div>
      <SaveCharacterDialog />
      <CharacterLibraryDialog />
    </ReactFlowProvider>
  );
}

export default CanvasEditor;
