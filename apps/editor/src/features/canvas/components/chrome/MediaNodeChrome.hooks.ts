'use client';

import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useStore as useReactFlowStore } from '@xyflow/react';
import { useOverlayLayer } from '@iart/ui';
import { toast } from 'sonner';

import { useCanvasStore } from '../../store/canvasStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import {
  addNodesToReferences,
  removeAssetsFromReferences,
  resolveReferenceAdmission,
  resolveReferenceCandidate,
  type ReferenceCandidate,
} from '@/features/promptdock/referenceOps';
// 加入参考的结果反馈 toast 与会话视图产物入口共用同一实现（禁止各面各写一份映射）。
import { announceReferenceAddResult } from '@/features/promptdock/referenceFeedback';
import { reuseAssetToDraft } from '@/features/promptdock/assetReuse';
import { addNodesToPackageArea } from '@/features/package-area/ops';
import {
  buildBottomBarView,
  resolveMediaChromeSelection,
  type MediaChromeToolId,
} from './chromeModel';
import type { ChromeSubject } from './mediaNodeModel';
import { runDirectTransform, type ToolCtx } from './mediaToolExecutors';
import type { MediaChromeState } from './MediaNodeChrome.types';
import type { AssetNodeData } from '../../types/taskNode';
import type { GraphNode } from '../../types/node';

/**
 * 媒体节点选中态 chrome 状态层（设计层 node-chrome.js 的真实实现映射）。
 * 覆盖资产节点与导入素材节点（D27 同一套外壳）；工具执行器在 mediaToolExecutors.ts；
 * 选中集→视图判定纯函数在 chromeModel.ts。
 */

const DEFAULT_BOTTOM_RESERVE = 96;

/** 选中集 → chrome 状态（仅全部为媒体节点时 active；拖动期间保持可见）。 */
export function useMediaChromeState(): MediaChromeState {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const mediaAssets = useCanvasStore((s) => s.mediaAssets);
  const references = usePromptDockStore((s) => s.draft.references);
  const catalog = usePromptDockStore((s) => s.catalog);
  const draftModelId = usePromptDockStore((s) => s.draft.modelId);

  const nodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of nodeGraph?.nodes ?? []) map.set(node.id, node);
    return map;
  }, [nodeGraph]);

  const selection = useMemo(
    () => resolveMediaChromeSelection(selectedNodeIds, nodesById, mediaAssets),
    [selectedNodeIds, nodesById, mediaAssets],
  );

  const referenceAssetIds = useMemo(
    () => new Set(references.map((r) => r.assetId)),
    [references],
  );

  const bottomView = useMemo(
    () => buildBottomBarView({ selection, referenceAssetIds, mediaAssets }),
    [selection, referenceAssetIds, mediaAssets],
  );

  const singleSubject = selection.single;

  // 参考动作可用性：按当前模型的输入能力与参考位余量预判（来源无关）。
  // 批内多选只要有一项能加就放行，具体拒绝项由操作层逐项反馈。
  const refAction = useMemo(() => {
    if (selection.subjects.length === 0) return { enabled: false, reason: null };
    const entry = catalog.find((item) => item.model_id === draftModelId) ?? null;
    const admissions = selection.subjects.map((subject) =>
      resolveReferenceAdmission({
        node: subject.node,
        mediaAssets,
        entry,
        references,
      }),
    );
    if (admissions.some((admission) => admission.ok)) {
      return { enabled: true, reason: null };
    }
    const blocked = admissions.find((admission) => !admission.ok);
    return { enabled: false, reason: blocked?.reason ?? null };
  }, [selection.subjects, catalog, draftModelId, mediaAssets, references]);

  return {
    selection,
    bottomView,
    singleSubject,
    hasMedia: Boolean(singleSubject?.available),
    refAction,
  };
}

export type MediaChromeActions = ReturnType<typeof useMediaChromeActions>;

/** 底栏动作：用作参考 toggle（含飞行反馈）/ 复用（仅生成资产）/ 打包 / 删除 inline 确认。 */
export function useMediaChromeActions(params: {
  subjectsRef: React.RefObject<ChromeSubject[]>;
  bottomBarRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [processingTool, setProcessingTool] = useState<MediaChromeToolId | null>(null);

  // 删除确认态是独立浮层（spec docs/editor/浮层堆叠管理.md「业务面接入清单」节点 chrome 一行）：
  // Esc 优先取消确认由栈顶派发（栈序保证先于画布基底的清选择），替代原先
  // document capture + stopPropagation 抢占；`active` 与确认态同源。
  useOverlayLayer({
    active: deleteConfirm,
    id: 'media-node-chrome-delete-confirm',
    onClose: () => setDeleteConfirm(false),
  });

  const toggleRefs = useCallback(() => {
    const nodes = (params.subjectsRef.current ?? []).map((subject) => subject.node);
    if (nodes.length === 0) return;
    const referenceAssetIds = new Set(
      usePromptDockStore.getState().draft.references.map((r) => r.assetId),
    );
    const mediaAssets = useCanvasStore.getState().mediaAssets;
    const okAssetIds = nodes
      .map((n) => resolveReferenceCandidate(n, mediaAssets))
      .filter((c): c is Extract<ReferenceCandidate, { ok: true }> => c.ok)
      .map((c) => c.assetId);
    const allIn = okAssetIds.length > 0 && okAssetIds.every((id) => referenceAssetIds.has(id));
    if (allIn) {
      removeAssetsFromReferences(okAssetIds);
      toast.info(okAssetIds.length === 1 ? '已取消参考' : `已取消 ${okAssetIds.length} 项参考`);
      return;
    }
    // D26 飞行反馈：从底栏飞向参考区；reduced-motion/无落点自动跳过。
    if (params.bottomBarRef.current) flyGhostToReferenceArea(params.bottomBarRef.current);
    // 操作层只返回结构化结果，toast 呈现由本面映射（文案与时机保持原口径）。
    announceReferenceAddResult(addNodesToReferences(nodes));
  }, [params.subjectsRef, params.bottomBarRef]);

  const reuse = useCallback(() => {
    const subject = (params.subjectsRef.current ?? [])[0];
    if (!subject || subject.family !== 'asset') return;
    const data = subject.node.data as AssetNodeData;
    reuseAssetToDraft(data);
    toast.success(
      data.sourceModelId ? `已复用生成参数 · ${data.sourceModelId}` : '已复用生成参数',
    );
  }, [params.subjectsRef]);

  // 加入打包区（spec「右侧工作区与打包区服务」）：候选判定/去重/反馈收口在 package-area ops。
  const addToPackageArea = useCallback(() => {
    const nodes = (params.subjectsRef.current ?? []).map((subject) => subject.node);
    if (nodes.length === 0) return;
    void addNodesToPackageArea(nodes);
  }, [params.subjectsRef]);

  const requestDelete = useCallback(() => setDeleteConfirm(true), []);
  const cancelDelete = useCallback(() => setDeleteConfirm(false), []);
  const confirmDelete = useCallback(() => {
    const subjects = params.subjectsRef.current ?? [];
    if (subjects.length === 0) return;
    useCanvasStore.getState().deleteSelectedElements();
    toast.success(subjects.length > 1 ? `已删除 ${subjects.length} 项` : '已删除');
    setDeleteConfirm(false);
  }, [params.subjectsRef]);

  const runDirectTool = useCallback(
    (toolId: 'mirrorX' | 'mirrorY' | 'rotate90', ctx: ToolCtx) => {
      if (processingTool) return;
      setProcessingTool(toolId);
      void runDirectTransform(ctx, toolId).finally(() => setProcessingTool(null));
    },
    [processingTool],
  );

  return {
    deleteConfirm,
    setDeleteConfirm,
    processingTool,
    toggleRefs,
    reuse,
    addToPackageArea,
    requestDelete,
    cancelDelete,
    confirmDelete,
    runDirectTool,
  };
}

/**
 * D17/D24 定位：顶栏/底栏各自 offset 14（BAR_GAP），水平居中于选区 bbox，
 * 顶栏贴顶折返、底栏为 PromptDock 让位折返，双触边堆叠钳制，横向视口钳制。
 * 移植 prototypes/shared/node-chrome.js positionChrome（imperative 写 style，
 * bar 尺寸经自身 DOM 测量；拖拽/平移中经 geom 订阅跟手）。
 */
export function useChromePlacement(params: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  topBarRef: React.RefObject<HTMLDivElement | null>;
  bottomBarRef: React.RefObject<HTMLDivElement | null>;
  selectedIds: readonly string[];
  /** 顶栏是否渲染（单选且该媒体有工具） */
  showTop: boolean;
  /** 重放进入场动画的 key（选中集变化时变化） */
  animateKey: string;
  /** 容器尺寸变化计数（窗口缩放 / 右栏开合） */
  resizeTick: number;
}): void {
  const selectedIdsKey = params.selectedIds.join('|');
  // 订阅 viewport transform + 选中节点绝对位置/尺寸（拖拽中亦持续更新，chrome 跟手）。
  // selector 防御式读取：部分 mock 状态（测试 harness）下 nodeLookup/internals 可缺省。
  const geom = useReactFlowStore(
    useCallback(
      (s) => {
        const out: number[] = [s.transform[0], s.transform[1], s.transform[2]];
        for (const id of selectedIdsKey ? selectedIdsKey.split('|') : []) {
          const node = s.nodeLookup?.get(id);
          if (!node) continue;
          const px = node.internals?.positionAbsolute.x;
          const py = node.internals?.positionAbsolute.y;
          if (px === undefined || py === undefined) continue;
          out.push(px, py, node.measured?.width ?? 0, node.measured?.height ?? 0);
        }
        return out;
      },
      [selectedIdsKey],
    ),
    (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  );

  const {
    canvasRef,
    topBarRef,
    bottomBarRef,
    showTop: showTopFlag,
    resizeTick,
  } = params;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const topBar = topBarRef.current;
    const bottomBar = bottomBarRef.current;
    if (!canvas || !bottomBar) return;

    const BAR_GAP = 14;
    const H = canvas.clientHeight;
    const W = canvas.clientWidth;
    const dockEl = document.querySelector('[data-testid="promptdock"]');
    const RESERVE = dockEl ? dockEl.getBoundingClientRect().height + 32 : DEFAULT_BOTTOM_RESERVE;

    // bbox 主路径：DOM 实测（设计层原型 selBox 同一事实源）。store geom 的 measured
    // 可能缺失/为 0（节点未完成 DOM 测量、占位壳降级期），bbox 会塌缩成节点左上角一个点
    // （双栏叠在节点顶部、以左缘为中心）；getBoundingClientRect 恒为真实几何。
    const canvasRect = canvas.getBoundingClientRect();
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const id of selectedIdsKey ? selectedIdsKey.split('|') : []) {
      const el = canvas.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const nr = el.getBoundingClientRect();
      if (nr.width === 0 && nr.height === 0) continue;
      l = Math.min(l, nr.left - canvasRect.left);
      t = Math.min(t, nr.top - canvasRect.top);
      r = Math.max(r, nr.right - canvasRect.left);
      b = Math.max(b, nr.bottom - canvasRect.top);
    }
    // 兜底：DOM 不可得（节点被虚拟化未挂载）→ 用 store geom 快照。
    if (!Number.isFinite(l)) {
      const tx = geom[0] ?? 0;
      const ty = geom[1] ?? 0;
      const z = geom[2] ?? 1;
      for (let i = 3; i + 3 < geom.length; i += 4) {
        const nx = geom[i] ?? 0;
        const ny = geom[i + 1] ?? 0;
        const nw = (geom[i + 2] ?? 0) * z;
        const nh = (geom[i + 3] ?? 0) * z;
        const sx = nx * z + tx;
        const sy = ny * z + ty;
        l = Math.min(l, sx);
        t = Math.min(t, sy);
        r = Math.max(r, sx + nw);
        b = Math.max(b, sy + nh);
      }
    }
    if (!Number.isFinite(l)) return;

    const showTop = showTopFlag && topBar;
    const th = showTop ? (topBar?.offsetHeight ?? 0) : 0;
    const bh = bottomBar.offsetHeight;

    let topY = t - th - BAR_GAP;
    const topFlipped = showTop && topY < 8;
    if (topFlipped) topY = b + BAR_GAP;

    let botY = b + BAR_GAP;
    const botFlipped = botY + bh > H - RESERVE;
    if (botFlipped) botY = t - bh - BAR_GAP;

    if (showTop) {
      if (!topFlipped && botFlipped) {
        botY = Math.min(botY, topY - bh - 8);
        if (botY < 8) {
          topY = b + BAR_GAP;
          botY = topY + th + 8;
        }
      } else if (topFlipped) {
        botY = Math.max(botY, topY + th + 8);
      }
    } else if (botY < 8) {
      botY = Math.min(Math.max(8, botY), H - RESERVE - bh);
    }
    if (topFlipped) topY = Math.min(topY, H - RESERVE - th);
    botY = Math.min(botY, H - RESERVE - bh);
    if (botY < 8) botY = 8;

    const place = (el: HTMLElement, cx: number, y: number) => {
      const w = el.offsetWidth;
      let left = cx - w / 2;
      if (left < 8) left = 8;
      if (left + w > W - 8) left = W - w - 8;
      el.style.left = `${left}px`;
      el.style.top = `${y}px`;
    };
    if (showTop && topBar) place(topBar, (l + r) / 2, topY);
    place(bottomBar, (l + r) / 2, botY);
  }, [geom, selectedIdsKey, showTopFlag, canvasRef, topBarRef, bottomBarRef, resizeTick]);

  // 选中集变化时重放进入场动画（D26：出现 160ms opacity+4px 位移）。
  // 强制 reflow（void offsetHeight）重置过渡起点，同步加类——不依赖 rAF：
  // 窗口被遮挡/最小化时 Electron 冻结 rAF，双 rAF 方案会让 chrome 永远停在
  // opacity:0 + pointer-events:none（点击工具无响应的现场根因之一）。
  const { animateKey } = params;
  const topBarRefForAnim = params.topBarRef;
  const bottomBarRefForAnim = params.bottomBarRef;
  useLayoutEffect(() => {
    const topBar = topBarRefForAnim.current;
    const bottomBar = bottomBarRefForAnim.current;
    if (!bottomBar) return;
    bottomBar.classList.remove('is-visible');
    topBar?.classList.remove('is-visible');
    void bottomBar.offsetHeight;
    topBar?.classList.add('is-visible');
    bottomBar.classList.add('is-visible');
  }, [animateKey, topBarRefForAnim, bottomBarRefForAnim]);
}

/**
 * D26：「用作参考」飞行反馈 ghost chip —— 从底栏飞向 PromptDock 参考区。
 * 非阻塞去向反馈；reduced-motion 跳过；参考区未挂载静默跳过。
 */
export function flyGhostToReferenceArea(sourceEl: HTMLElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = document.querySelector('[data-testid="promptdock-reference-area"]');
  if (!target) return;
  const ghost = document.createElement('div');
  ghost.className = 'ref-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const selectedMedia = document.querySelector(
    '.asset-node.is-selected img.asset-media',
  );
  const src = selectedMedia instanceof HTMLImageElement ? selectedMedia.src : '';
  const thumb = src ? `<span class="thumb"><img src="${src}" alt="" /></span>` : '';
  ghost.innerHTML = `${thumb}<span>用作参考</span>`;
  document.body.appendChild(ghost);
  const sr = sourceEl.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const gw = ghost.offsetWidth;
  const gh = ghost.offsetHeight;
  const sx = sr.left + sr.width / 2 - gw / 2;
  const sy = sr.bottom - gh / 2;
  const tx = tr.left + Math.min(tr.width / 2, 60) - gw / 2;
  const ty = tr.top + tr.height / 2 - gh / 2;
  ghost.style.left = `${sx}px`;
  ghost.style.top = `${sy}px`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${tx - sx}px, ${ty - sy}px) scale(.55)`;
      ghost.style.opacity = '0';
    });
  });
  window.setTimeout(() => {
    ghost.remove();
  }, 390);
}
