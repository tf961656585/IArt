'use client';

import { memo, useCallback } from 'react';
import { type NodeProps } from '@xyflow/react';

import { formatBeijingShortDateTime } from '@/shared/utils/time';
import { cn } from '@/lib/utils';
import type { AgentNodeData, GraphNode } from '../../types/node';
import { useNodeFromStore } from '../../hooks/useNodeFromStore';
import { useLocateToNode, type LocateToNodeFn } from '../../hooks/useLocateToNode';
import {
  useAgentSessionInFlight,
  useAgentSessionMeta,
} from '@/features/agent/agentSessionStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '../../store/canvasStore';
import { selectContainerMemberCount } from '../../store/internal/containerMemberIndex';
import {
  GROUP_HEADER_HEIGHT,
  GROUP_LOD_ANCHOR_SCREEN_SIZE,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_COLLAPSED_HEIGHT,
  isContainerLodDegraded,
  shouldShowContainerGrip,
  shouldShowAgentLeafGrip,
  computeLodAnchorLocateZoom,
} from '../../services/groupGeometry';
import { useCanvasZoom, useContainerGripPlacement } from '../../hooks/useCanvasViewport';
import { CollapseIcon, ExpandIcon } from './GroupNode';
import { ContainerGrip, GripDots } from './ContainerGrip';
// 容器共享组件级样式（背板/折叠卡 keyframes、--group-anchor-text；自 globals.css 下沉）
import './containerNodes.css';

/**
 * Agent 节点 / Agent 容器渲染组件（spec docs/agent/02-Agent节点与画布投影.md「节点形态」、
 * docs/runtime/画布节点组.md 容器机制；视觉决策 CN-V-01~07、CN-V-09）。
 *
 * 同体两态（无新增节点类型）：
 * - 单节点形态（无成员，静态 240×64 由 layoutModel 承载）：既有 .agent-surface 卡片——
 *   头部直显语言模型 `model_id`（不翻译、不显示 Provider 明细）、会话标题、审批档位；
 *   副行给会话摘要（消息量 + 最近一次对话时间，北京时间；孵化期为「正在回复…」）。
 * - 容器形态（有成员）：与组围栏模型同构的 accent 背板（pointer-events 穿透、hairline 1/zoom、
 *   6% 常态底 / 选中 12% / 拖动 10% / 拖入 12%，被组包裹降 4% 嵌套档）+ 32px 容器交互条 chip
 *   （标题入 chip、model_id mono 11px 必显、流式脉冲缩为 chip 内 dot、审批档降为 chip 尾 pill）；
 *   副行退场（仅单节点形态与孵化期显示）。
 * - 折叠态（data.collapsed，与组同一 toggleGroupCollapse 机制）：组折叠卡同构——展开钮 +
 *   标题 + model_id 截断 + 成员计数徽章；成员不挂载由机制层承载。
 *
 * 屏幕恒定容器握把（AG-CN-019）：展开容器在「容器头屏幕高 < 28 或容器最短边 < 120」时
 * 于容器框上方显示握把（视觉 24px / 命中 44px，顶边时翻转进框内首行）；单节点形态 Agent
 * （无成员、整卡可拖）只在卡片屏幕高 < 48px 时显示。握把无 nodrag，拖动走 React Flow 既有
 * 节点拖动链路，单击定位走既有 locateToNode。容器头 chip 与折叠卡常显 2×3 握把点。
 *
 * LOD（AG-CN-021）：折叠卡屏幕宽 < 120px 或屏幕高 < 48px 时降级为 44px 屏幕恒定锚点
 * （居中于容器框、整块可拖、Enter/Space 定位）；100% 缩放下折叠卡正常显示。
 *
 * 计数口径（AG-NP-005 / AG-CT-005 / AG-CT-007）：成员计数徽章只在折叠态展示，**计数=容器
 * 成员数**（selectContainerMemberCount 增量索引，禁容器实例扫描全图、与会话产物消息脱钩），
 * 展开态退场（成员可见即复读），零值不显示；只读、不内嵌产物网格（浏览回到会话视图）。
 *
 * 只持稳定引用：模型与会话摘要都从会话元数据 store 读取，节点 data 只有 `agentSessionId`
 * （+ 视图态 `collapsed`）；会话缺失（导入的项目、会话被删）时呈现不可用态。
 * 选中环：单节点/折叠卡形态沿用根 .is-selected（2px accent 细环 + 柔光晕）；容器形态环落
 * 背板（根不带 is-selected，单环不叠，CN-V-07）；PromptDock 绑定环沿用既有 is-bound 机制。
 */

type AgentNodeSelection = {
  node: GraphNode<AgentNodeData> | null;
  data: AgentNodeData;
};

const createFallbackAgentNode = (id: string): GraphNode<AgentNodeData> => ({
  id,
  type: 'agent' as const,
  position: { x: 0, y: 0 },
  data: { label: 'Agent', agentSessionId: '' },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const APPROVAL_LABEL = {
  confirm: '逐条确认',
  yolo: '自动执行',
} as const;

const UNAVAILABLE_MODEL_ID = '模型不可用';
const UNAVAILABLE_SESSION_SUMMARY = '这个会话已经不在了，删掉这个节点';

/** 容器背板常态边框：身份色 40% × --color-border（组配方同构，深档随 --color-border 自派生）。 */
const AGENT_BASE_BORDER_CLASS =
  'border-[color-mix(in_srgb,var(--agent-accent)_40%,var(--color-border))]';

/** paint 级过渡（只动背景/边框/阴影，150ms 甜区；拖出瞬间描边 150ms 淡回常态、底不闪——CN-V-06）。 */
const AGENT_TRANSITION_CLASS =
  'transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none';

/**
 * 容器背板（纯视觉层，CN-V-01 与组配方同构）：常态身份色 6% 底（被组包裹降 4% 嵌套档，
 * CN-V-07）+ hairline；选中 12% + select-ring + glow；拖动中 10%；拖入目标 12% + 内侧描边。
 * 拖出（失去拖入目标/拖拽结束）经 AGENT_TRANSITION 淡回常态，零视觉残留（禁虚线弧/ghost/角标）。
 */
const buildAgentSurfaceClass = (params: {
  selected: boolean;
  isDropTarget: boolean;
  isDraggingSelf: boolean;
  nested: boolean;
  bound: boolean;
}) =>
  cn(
    'pointer-events-none absolute inset-0 rounded-[6px] border',
    AGENT_BASE_BORDER_CLASS,
    params.nested
      ? 'bg-[var(--agent-surface-nested)]'
      : 'bg-[color-mix(in_srgb,var(--agent-accent)_6%,transparent)]',
    'animate-[iart-group-surface-in_120ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none',
    AGENT_TRANSITION_CLASS,
    params.selected &&
      'border-[var(--select-ring)] bg-[color-mix(in_srgb,var(--agent-accent)_12%,transparent)] shadow-[0_0_0_4px_var(--select-glow)]',
    !params.selected &&
      params.isDraggingSelf &&
      'border-[var(--agent-accent)] bg-[color-mix(in_srgb,var(--agent-accent)_10%,transparent)]',
    // 拖入目标：底板加深 + 内侧 1px 描边（「框在收拢」信号）；瞬态落点信号优先于选中态
    params.isDropTarget &&
      'border-[var(--agent-accent)] bg-[color-mix(in_srgb,var(--agent-accent)_12%,transparent)] shadow-[inset_0_0_0_1px_var(--agent-accent)]',
    // 绑定环升级（spec 02「绑定态视觉」）：选中环加粗 2.5px accent 描边，单环不叠
    params.selected &&
      params.bound &&
      'shadow-[0_0_0_2.5px_var(--select-ring),0_0_0_6px_var(--select-glow)]',
  );

/** 容器头 chip（组标题 chip 同构：h-6 视觉实体，32px 交互条内）。 */
const buildAgentChipClass = () =>
  cn(
    'inline-flex h-6 min-w-0 items-center gap-1 rounded-md border pr-1.5 pl-0.5',
    'border-[color-mix(in_srgb,var(--agent-accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--agent-accent)_12%,var(--card))] hover:bg-[color-mix(in_srgb,var(--agent-accent)_18%,var(--card))]',
    'transition-[background,border-color] duration-150 motion-reduce:transition-none',
  );

/** chip / 折叠卡内 24×24 ghost 圆角钮（收起、展开）；WCAG 2.5.8 命中区 ≥24px。 */
const AGENT_BUTTON_CLASS = cn(
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-none bg-transparent p-0',
  'hover:bg-[color-mix(in_srgb,var(--agent-accent)_18%,var(--card))]',
  'focus-visible:outline-2 focus-visible:outline-[var(--chrome-ring)] focus-visible:outline-offset-2',
  'transition-colors duration-150 motion-reduce:transition-none',
);

/**
 * 成员计数徽章（折叠态唯一计数出口，AG-CT-005）：构图沿用组徽章 GROUP_BADGE_CLASS
 * （rounded-full + 身份色 10% × card 底），文字档走 --agent-accent-text（浅 700 / 深 300，
 * 禁身份色 500 档直出文字）。零成员不渲染（零值不是信息）。
 */
const AGENT_BADGE_CLASS = cn(
  'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-tight tabular-nums',
  'bg-[color-mix(in_srgb,var(--agent-accent)_10%,var(--card))] text-[var(--agent-accent-text)]',
);

/**
 * 定位 no-op（组件级测试无 RF Provider 裸渲染时的降级；真实画布恒有 Provider 走完整链）。
 */
const noopLocate: LocateToNodeFn = () => undefined;

/**
 * useLocateToNode 裸渲染降级（useOptionalReactFlow 同款 try/catch 先例）：定位链内部
 * useCanvasSelectionBridge 直接调 useReactFlow，无 Provider 时抛错。降级只发生在无 Provider
 * 的固定环境（组件级测试），渲染间钩子调用序列恒定，不产生钩子数漂移。
 */
const useOptionalLocateToNode = (): LocateToNodeFn => {
  try {
    return useLocateToNode();
  } catch {
    return noopLocate;
  }
};

export const AgentNode = memo(function AgentNode({
  id,
  selected,
  width,
  height,
  positionAbsoluteY,
}: NodeProps) {
  const { data: nodeData, node } = useNodeFromStore<AgentNodeData, AgentNodeSelection>({
    nodeId: id,
    fallback: createFallbackAgentNode(id),
    select: (snapshot) => ({ node: snapshot.node, data: snapshot.data }),
    equalityFn: (prev, next) => prev.node === next.node && prev.data === next.data,
  });

  const typed = nodeData as AgentNodeData;
  const agentSessionId = typeof typed.agentSessionId === 'string' ? typed.agentSessionId : '';
  const session = useAgentSessionMeta(agentSessionId || null);
  const inFlight = useAgentSessionInFlight(agentSessionId || null);
  // 成员计数：消费容器成员计数增量索引（AG-CT-007 禁容器实例扫描全图；不订阅会话产物消息，
  // 计数与成功产物数彻底脱钩——AG-NP-005 2026-09-22 口径改写）。selector 返回原始 number。
  const memberCount = useCanvasStore((state) => selectContainerMemberCount(state, id));
  // 拖入目标 / 拖动中反馈：change controller 对组与 Agent 容器同一通道写入（CN-V-01 三档）
  const isDropTarget = useCanvasStore((state) => state.ui.groupDropTargetGroupId === id);
  const isDraggingSelf = useCanvasStore((state) => state.ui.groupDraggingId === id);
  const toggleGroupCollapse = useCanvasStore((state) => state.toggleGroupCollapse);
  // 视口读取拆成两个 primitive selector：zoom 只随缩放变；握把放置只在 above ↔ inside
  // 翻转时变（平移不再让所有容器节点逐帧重渲染）。
  const zoom = useCanvasZoom();
  const absoluteY = typeof positionAbsoluteY === 'number' ? positionAbsoluteY : 0;
  const gripPlacement = useContainerGripPlacement(absoluteY);
  const locateToNode = useOptionalLocateToNode();
  // 绑定环（spec 02「选中态工具栏·绑定态视觉」）：PromptDock 正绑定该节点会话时升级选中环。
  // 从 PromptDock store 派生，不写进节点 data（节点只持会话稳定引用）。
  const boundToPromptDock = usePromptDockStore(
    (state) =>
      state.form === 'agent' &&
      state.agentBinding !== null &&
      state.agentBinding.nodeId === id,
  );

  const modelId = session !== null && session.modelId ? session.modelId : null;
  const title = session !== null && session.title ? session.title : null;
  const approvalLabel = session !== null ? APPROVAL_LABEL[session.approvalMode] : null;

  // 头部固定显示模型位（会话读不到 / 模型未知时同为「模型不可用」，不把会话口径挪到 model_id 的位置）
  const headModelText = modelId ?? UNAVAILABLE_MODEL_ID;
  // 副行（仅单节点形态与孵化期显示，CN-V-02）：会话可用时给「消息量 + 最近一次对话时间」
  // （lastMessageAt，存储写入端维护）。不用 updatedAt——配置变更（思考档位 / 审批规则）会抬升它。
  // 计数为 0 时不示人（零值不是信息）；没有消息时（lastMessageAt 为 null）不显示时间段。
  const lastMessageText =
    session !== null && session.lastMessageAt !== null
      ? formatBeijingShortDateTime(session.lastMessageAt)
      : '';
  const summaryText =
    session === null
      ? UNAVAILABLE_SESSION_SUMMARY
      : inFlight !== null
        ? '正在回复…'
        : [
            session.messageCount > 0 ? `消息 ${session.messageCount} 条` : '',
            lastMessageText,
          ]
            .filter((part) => part.length > 0)
            .join(' · ');

  // 形态判定（CN-V-04 同体两态 + 折叠）：无成员恒单节点形态；成员落地即容器形态；
  // data.collapsed 为视图态（与组同一机制），折叠优先于形态。
  const collapsed = typed.collapsed === true;
  const hasMembers = memberCount > 0;
  const form: 'leaf' | 'container' | 'collapsed' = collapsed
    ? 'collapsed'
    : hasMembers
      ? 'container'
      : 'leaf';
  // 嵌套底档（CN-V-07）：Agent 容器被组包裹（node.groupId 非空）时常态底 6% → 4%
  const nestedInGroup =
    node !== null && typeof node.groupId === 'string' && node.groupId.length > 0;
  // 折叠卡/气泡/锚点的显示名：会话标题优先，回退节点 label（与派生尺寸宽度估算同源）
  const displayName = title ?? (typed.label.length > 0 ? typed.label : 'Agent');

  // 恒定 hairline：边框宽度取 1/zoom 画布 px，任意缩放下屏幕宽度恒为 1px（组同构）
  const hairlineBorderWidth = zoom > 0 ? 1 / zoom : 1;
  // LOD 判定（触发维度是屏幕空间尺寸 = 画布尺寸 × zoom；初渲染 width/height 未注入时不降级）
  const screenW = typeof width === 'number' ? width * zoom : Number.POSITIVE_INFINITY;
  const screenH = typeof height === 'number' ? height * zoom : Number.POSITIVE_INFINITY;
  const isLodDegraded = form === 'collapsed' && isContainerLodDegraded(screenW, screenH);
  // 屏幕恒定容器握把（AG-CN-019）：
  // - 容器形态：容器头屏幕高 < 28 或容器最短边 < 120 时显示；
  // - 单节点形态：只在卡片屏幕高 < 48px 时显示（100% 缩放下与卡片自身标题重复，不显示）。
  const showContainerGrip =
    form === 'container' &&
    shouldShowContainerGrip({
      headerScreenHeight: GROUP_HEADER_HEIGHT * zoom,
      screenWidth: screenW,
      screenHeight: screenH,
    });
  const showLeafGrip = form === 'leaf' && shouldShowAgentLeafGrip(screenH);
  // 握把放置（above / 顶边翻转 inside）由 useContainerGripPlacement 的 primitive selector 承载。

  const handleToggleCollapse = useCallback(() => {
    toggleGroupCollapse(id);
  }, [id, toggleGroupCollapse]);

  // LOD 锚点点击：居中定位到容器，zoom 反算保证聚焦后脱离降级态，容器保持折叠（复用主抽象）
  const handleLodAnchorClick = useCallback(() => {
    const locateZoom = computeLodAnchorLocateZoom(
      typeof width === 'number' ? width : GROUP_COLLAPSED_MIN_WIDTH,
      typeof height === 'number' ? height : GROUP_COLLAPSED_HEIGHT,
    );
    locateToNode(id, 'lod-anchor-click', { zoom: locateZoom, duration: 300, select: true });
  }, [id, locateToNode, width, height]);

  const handleGripClick = useCallback(() => {
    locateToNode(id, 'container-grip-click', { zoom: 1, duration: 300, select: true });
  }, [id, locateToNode]);

  const sessionStateAttr =
    session === null ? 'unavailable' : inFlight !== null ? 'replying' : 'ready';
  const boundAttr = boundToPromptDock ? 'true' : undefined;

  // ---- 折叠态：LOD 锚点 / 组折叠卡同构信息卡（CN-V-05） ----
  if (form === 'collapsed') {
    // 屏幕宽 < 120 或高 < 48（AG-CN-021）：固定 44px 屏幕尺寸锚点块，居中于容器框，
    // 整块可拖、Enter/Space 定位。
    if (isLodDegraded) {
      const inverseScale = zoom > 0 ? 1 / zoom : 1;
      const canvasSize = GROUP_LOD_ANCHOR_SCREEN_SIZE * inverseScale;
      const initial = displayName.length > 0 ? displayName.charAt(0) : '?';
      const anchorLeft = typeof width === 'number' ? (width - canvasSize) / 2 : 0;
      const anchorTop = typeof height === 'number' ? (height - canvasSize) / 2 : 0;
      const anchorLabel = `${displayName} · ${memberCount} 成员（拖动移动；单击定位）`;
      return (
        <div
          data-agent-node={id}
          data-agent-form="collapsed"
          data-session-state={sessionStateAttr}
          data-bound={boundAttr}
          data-testid="container-lod-anchor"
          role="button"
          tabIndex={0}
          aria-label={anchorLabel}
          className={cn(
            'agent-node pointer-events-auto flex cursor-pointer items-center justify-center rounded-[6px] border shadow-sm transition-shadow',
            AGENT_TRANSITION_CLASS,
            AGENT_BASE_BORDER_CLASS,
            selected && 'border-[var(--select-ring)] shadow-[0_0_0_2px_var(--select-ring),0_0_0_6px_var(--select-glow)]',
          )}
          style={{
            position: 'absolute',
            left: anchorLeft,
            top: anchorTop,
            width: canvasSize,
            height: canvasSize,
            backgroundColor: 'var(--agent-accent)',
            fontSize: Math.floor(GROUP_LOD_ANCHOR_SCREEN_SIZE * 0.5 * inverseScale),
            fontWeight: 700,
            borderWidth: hairlineBorderWidth,
            borderRadius: 10 * inverseScale,
          }}
          onClick={handleLodAnchorClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleLodAnchorClick();
            }
          }}
          title={anchorLabel}
        >
          <span className="text-[var(--group-anchor-text)]">{initial}</span>
        </div>
      );
    }

    // 折叠信息卡：展开钮 + 标题 + model_id 截断 + 成员计数徽章；挂载淡入 150ms（组同构）
    return (
      <div
        data-agent-node={id}
        data-agent-form="collapsed"
        data-session-state={sessionStateAttr}
        data-bound={boundAttr}
        style={{ borderWidth: hairlineBorderWidth }}
        className={cn(
          'agent-node pointer-events-auto flex h-full w-full items-center gap-2 rounded-[6px] border pl-2 pr-3 box-border',
          AGENT_BASE_BORDER_CLASS,
          'bg-[color-mix(in_srgb,var(--agent-accent)_12%,transparent)]',
          'shadow-[var(--shadow-sm)]',
          'animate-[iart-group-card-in_150ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none',
          AGENT_TRANSITION_CLASS,
          selected &&
            'border-[var(--select-ring)] shadow-[0_0_0_4px_var(--select-glow),var(--shadow-md)]',
          isDraggingSelf && 'cursor-grabbing',
        )}
      >
        <button
          type="button"
          onClick={handleToggleCollapse}
          className={cn(AGENT_BUTTON_CLASS, 'nodrag')}
          title="展开容器"
        >
          <ExpandIcon />
        </button>
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-none text-foreground"
          title={displayName}
        >
          {displayName}
        </span>
        <span
          className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-[var(--muted-foreground)]"
          title={headModelText}
        >
          {headModelText}
        </span>
        {/* 成员计数徽章（折叠态唯一计数出口，AG-NP-005/AG-CT-005）：只读，零成员不显示 */}
        {memberCount > 0 ? (
          <span
            className={AGENT_BADGE_CLASS}
            data-testid="agent-node-member-count"
            title={`${memberCount} 个成员`}
          >
            {memberCount}
          </span>
        ) : null}
        {/* 折叠卡常显 2×3 握把点（零成员徽章不显示时仍显示，AG-CN-019） */}
        <GripDots size={2} />
      </div>
    );
  }

  // ---- 容器形态：accent 背板 + 32px 容器交互条 chip（CN-V-01/02/04） ----
  if (form === 'container') {
    return (
      <div
        data-agent-node={id}
        data-agent-form="container"
        data-session-state={sessionStateAttr}
        data-bound={boundAttr}
        // 围栏模型：容器区透空（外层 RF 包裹容器经防御 CSS 一并透空），交互实体收缩到头部条；
        // 点击成员命中成员、点击间隙穿透到画布。选中环只落背板（根不带 is-selected，单环不叠）。
        className="agent-node pointer-events-none h-full w-full"
      >
        {/* 背板：纯视觉层（指针穿透），成员之上由投影层 zIndex=-1 沉底（组背板 -2 之下不适用） */}
        <div
          data-testid="agent-container-surface"
          className={buildAgentSurfaceClass({
            selected,
            isDropTarget,
            isDraggingSelf,
            nested: nestedInGroup,
            bound: boundToPromptDock,
          })}
          style={{ borderWidth: hairlineBorderWidth }}
          aria-hidden="true"
        />
        {/* 容器头：全宽 32px 交互条（收起钮、拖拽手柄在此；chip 为视觉实体） */}
        <div
          className="pointer-events-auto absolute left-0 right-0 top-0 flex items-start px-2"
          style={{ height: GROUP_HEADER_HEIGHT, paddingTop: 4 }}
        >
          <div
            data-testid="agent-container-chip"
            className={cn(
              buildAgentChipClass(),
              // 形态切换的头部交叉淡入：150ms 纯 opacity 遮盖单节点 ↔ 容器头位形切换（只动 paint）
              'animate-[iart-group-surface-in_150ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none',
            )}
          >
            {/* 容器头常显 2×3 握把点：提示标题条可拖（AG-CN-019） */}
            <GripDots size={2} />
            <button
              type="button"
              onClick={handleToggleCollapse}
              className={cn(AGENT_BUTTON_CLASS, 'nodrag')}
              title="收起容器"
            >
              <CollapseIcon />
            </button>
            {/* 流式脉冲：容器态缩为 chip 内 6px dot（会话进行态唯一活动信号） */}
            {inFlight !== null ? (
              <i
                data-testid="agent-chip-pulse"
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--agent-accent)] animate-[iart-hatch-breathe_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
              />
            ) : null}
            {/* model_id 必显口径：chip 内 mono 11px，不翻译、不显示 Provider 明细 */}
            <span
              className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] font-semibold text-foreground"
              title={headModelText}
            >
              {headModelText}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-xs font-semibold leading-none text-foreground"
              title={title ?? undefined}
            >
              {title ?? ''}
            </span>
            {/* 审批档：降为 chip 尾 11px pill（视觉语义与单节点形态 .agent-auth 同源） */}
            {approvalLabel !== null ? (
              <span
                data-testid="agent-chip-approval"
                data-mode={session?.approvalMode ?? 'confirm'}
                className={cn(
                  'flex-none whitespace-nowrap rounded border px-1 text-[11px] leading-tight border-[var(--border)] text-[var(--muted-foreground)]',
                  session?.approvalMode === 'yolo' &&
                    'border-[color-mix(in_srgb,var(--st-failed)_35%,var(--border))] text-[var(--st-failed-text)]',
                )}
              >
                {approvalLabel}
              </span>
            ) : null}
          </div>
        </div>
        {/* 屏幕恒定容器握把（AG-CN-019）：容器框上方（成员区域之外），顶边时翻转进框内。
            按钮无 nodrag：拖动走 React Flow 既有节点拖动链路；单击定位到容器。 */}
        {showContainerGrip ? (
          <ContainerGrip
            containerId={id}
            label={displayName}
            memberCount={memberCount}
            accent="var(--agent-accent)"
            zoom={zoom}
            screenWidth={screenW}
            placement={gripPlacement}
            isDragging={isDraggingSelf}
            onLocate={handleGripClick}
          />
        ) : null}
      </div>
    );
  }

  // ---- 单节点形态（无成员 240×64，既有卡片；孵化期副行「正在回复…」+ 脉冲） ----
  return (
    <div
      data-agent-node={id}
      data-agent-form="leaf"
      data-session-state={sessionStateAttr}
      data-bound={boundAttr}
      className={
        'agent-node pointer-events-auto h-full w-full' +
        (selected ? ' is-selected' : '') +
        (boundToPromptDock ? ' is-bound' : '')
      }
    >
      <div className="agent-surface">
        <div className="agent-head">
          <span className="agent-mark" aria-hidden="true">
            {inFlight !== null ? <i className="agent-mark-pulse" /> : null}
          </span>
          <span className="agent-id font-mono">{headModelText}</span>
          {title !== null ? <span className="agent-title">{title}</span> : null}
          {approvalLabel !== null ? (
            <span className="agent-auth" data-mode={session?.approvalMode ?? 'confirm'}>
              {approvalLabel}
            </span>
          ) : null}
        </div>
        <div className="agent-sub">{summaryText}</div>
      </div>
      {/* 单节点形态握把（AG-CN-019）：只在卡片屏幕高 < 48px 时显示，避免与卡片标题重复。 */}
      {showLeafGrip ? (
        <ContainerGrip
          containerId={id}
          label={displayName}
          memberCount={0}
          accent="var(--agent-accent)"
          zoom={zoom}
          screenWidth={screenW}
          placement={gripPlacement}
          isDragging={isDraggingSelf}
          onLocate={handleGripClick}
        />
      ) : null}
    </div>
  );
});

export default AgentNode;
