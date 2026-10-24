'use client';

import { memo, useCallback, useState, useRef, useEffect, type CSSProperties } from 'react';
import { type NodeProps } from '@xyflow/react';
import { useOverlayLayer } from '@iart/ui';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '../../store/canvasStore';
import { selectContainerMemberCount } from '../../store/internal/containerMemberIndex';
import { useNodeFromStore } from '../../hooks/useNodeFromStore';
import { useLocateToNode } from '../../hooks/useLocateToNode';
// 容器共享组件级样式（--group-anchor-text / .group-text-tier / 背板与折叠卡 keyframes；
// 自 globals.css 下沉，行数门禁零余量腾行）
import './containerNodes.css';
import type { GraphNode, GroupNodeData } from '../../types/node';
import {
  GROUP_HEADER_HEIGHT,
  GROUP_LOD_ANCHOR_SCREEN_SIZE,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_COLLAPSED_HEIGHT,
  isContainerLodDegraded,
  shouldShowContainerGrip,
  computeLodAnchorLocateZoom,
} from '../../services/groupGeometry';
import { useCanvasZoom, useContainerGripPlacement } from '../../hooks/useCanvasViewport';
import { ContainerGrip, GripDots } from './ContainerGrip';
import { GROUP_DEFAULT_COLOR, getGroupTextColors } from '../../services/groupPalette';

/**
 * 节点组渲染组件（围栏模型）。
 *
 * 组节点是逻辑父容器，不使用 BaseNodeCard（因为渲染逻辑与普通节点差异较大）。
 * - 展开态：组的可交互区域仅限标题栏（折叠按钮、组名编辑、拖拽手柄）。
 *   成员区域透空（pointer-events: none），成员节点作为 React Flow 平级节点渲染在透空区域之上，
 *   无需 z 序博弈即可被选中；成员之间的间隙穿透到画布。
 *   背板是纯视觉层：1px 实线混合边框（组色 40% × --color-border）+ 6% 组色底，
 *   全部经 color-mix 与主题令牌派生，明暗双主题自适应（样式经 Tailwind 任意值消费
 *   内联注入的 --group-* 变量，状态档位与选中语法对齐 visual-design.md D28）。
 *   左上标题 chip 只是视觉实体，header 交互条保持全宽（GROUP_HEADER_HEIGHT）。
 *   容器过小/头过矮时（AG-CN-019）在容器框上方显示屏幕恒定容器握把（视觉 24px / 命中 44px），
 *   顶到视口顶边时翻转为容器框内首行；握把无 nodrag，拖动走 React Flow 既有节点拖动链路，
 *   单击定位走既有 locateToNode。标题 chip 与折叠卡常显 2×3 握把点。
 * - 折叠态：独立信息卡片（spec：画布节点组.md「折叠态尺寸」），
 *   组名 + 成员数徽章 + 展开钮，常驻最低海拔（--shadow-sm），挂载时淡入。
 *   整块可交互。
 *
 * LOD（AG-CN-021）：折叠卡屏幕宽 < 120px 或屏幕高 < 48px 时降级为 44px 屏幕恒定锚点
 * （居中于容器框、整块可拖、Enter/Space 定位）；100% 缩放下 240×72 折叠卡正常显示。
 *
 * 交互契约：点击标题栏命中组；点击成员命中成员；点击成员间隙穿透到画布。
 *
 * 状态档位（对齐 visual-design.md §5.5 三档模式；组色 500 档永不直接做文字色）：
 *   常态 6% / 选中与拖入目标 12% / 拖组中 10%；选中态组色让位 --select-ring/--select-glow。
 */

const EXPANDED_HEADER_HEIGHT = GROUP_HEADER_HEIGHT;

type GroupNodeSelection = {
  node: GraphNode<GroupNodeData> | null;
  data: GroupNodeData;
};

/** 每实例注入的组色 CSS 变量（组色与配套文字档，派生混合在工具类里完成） */
type GroupCssVars = CSSProperties & {
  '--group-color': string;
  '--group-text-light': string;
  '--group-text-dark': string;
};

/** 文字档（浅 700 / 深 300 档），供 chip 内按钮与成员数徽章消费；
 *  .group-text-tier 在 containerNodes.css 承载 [data-theme] 切换（--group-text-light/dark
 *  由本组件按实例内联注入） */
const GROUP_TEXT_TIER_CLASS = 'group-text-tier';

/** 共享过渡：只动 paint 级属性，150ms 甜区时长；reduced-motion 时关闭 */
const GROUP_TRANSITION_CLASS =
  'transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none';

/** 1px 混合边框（常态）：组色 40% × --color-border，深色档随 --color-border 自动派生 */
const GROUP_BORDER_CLASS =
  'border-[color-mix(in_srgb,var(--group-color)_40%,var(--color-border))]';

/** 展开态背板（纯视觉层）：常态 / 选中（D28 选中环，组色让位）/ 拖组中 / 拖入目标 */
const buildSurfaceClass = (selected: boolean, isDropTarget: boolean, isDragging: boolean) =>
  cn(
    'pointer-events-none absolute inset-0 rounded-lg border',
    GROUP_BORDER_CLASS,
    'bg-[color-mix(in_srgb,var(--group-color)_6%,transparent)]',
    'animate-[iart-group-surface-in_120ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none',
    GROUP_TRANSITION_CLASS,
    selected &&
      'border-[var(--select-ring)] bg-[color-mix(in_srgb,var(--group-color)_12%,transparent)] shadow-[0_0_0_4px_var(--select-glow)]',
    !selected &&
      isDragging &&
      'border-[var(--group-color)] bg-[color-mix(in_srgb,var(--group-color)_10%,transparent)]',
    // 拖入目标：底板加深一倍 + 内侧 1px 描边（「框在收拢」信号，不用外圈发光）；
    // 瞬态落点信号优先于选中态呈现（cn 冲突去重按参数顺序后者胜）
    isDropTarget &&
      'border-[var(--group-color)] bg-[color-mix(in_srgb,var(--group-color)_12%,transparent)] shadow-[inset_0_0_0_1px_var(--group-color)]',
  );

/** 标题 chip：视觉实体，位于全宽 header 交互条内；重命名中切换为 card 实底 + ring 边框 */
const buildChipClass = (editingName: boolean) =>
  cn(
    'inline-flex h-6 items-center gap-0.5 rounded-md border pr-1.5 pl-0.5',
    'transition-[background,border-color] duration-150 motion-reduce:transition-none',
    'focus-within:border-[var(--ring)] focus-within:bg-[var(--card)]',
    editingName
      ? 'border-[var(--ring)] bg-[var(--card)]'
      : 'border-[color-mix(in_srgb,var(--group-color)_25%,transparent)] bg-[color-mix(in_srgb,var(--group-color)_12%,var(--card))] hover:bg-[color-mix(in_srgb,var(--group-color)_18%,var(--card))]',
  );

/** chip / 折叠卡内 24×24 ghost 圆角钮（折叠、展开）；WCAG 2.5.8 命中区 ≥24px */
const GROUP_BUTTON_CLASS = cn(
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-none bg-transparent p-0',
  GROUP_TEXT_TIER_CLASS,
  'hover:bg-[color-mix(in_srgb,var(--group-color)_18%,var(--card))]',
  'focus-visible:outline-2 focus-visible:outline-[var(--chrome-ring)] focus-visible:outline-offset-2',
  'transition-colors duration-150 motion-reduce:transition-none',
);

/** 成员数徽章：底为组色 10% × card，文字走色板文字档（禁组色 500 档直出文字） */
const GROUP_BADGE_CLASS = cn(
  'shrink-0 rounded-full px-1.5 py-0.5 font-medium leading-tight',
  'bg-[color-mix(in_srgb,var(--group-color)_10%,var(--card))]',
  GROUP_TEXT_TIER_CLASS,
);

export const GroupNode = memo(function GroupNode({
  id,
  selected,
  width,
  height,
  positionAbsoluteY,
}: NodeProps) {
  // 视口读取拆成两个 primitive selector：zoom 只随缩放变；握把放置只在 above ↔ inside
  // 翻转时变。平移（transform.y 持续变化）不再让所有容器节点逐帧重渲染。
  const zoom = useCanvasZoom();
  const absoluteY = typeof positionAbsoluteY === 'number' ? positionAbsoluteY : 0;
  const gripPlacement = useContainerGripPlacement(absoluteY);
  const locateToNode = useLocateToNode();
  const { data: nodeData } = useNodeFromStore<GroupNodeData, GroupNodeSelection>({
    nodeId: id,
    fallback: createFallbackGroupNode(id),
    select: (snapshot) => ({ node: snapshot.node, data: snapshot.data }),
    equalityFn: (prev, next) => prev.node === next.node && prev.data === next.data,
  });
  const renameGroup = useCanvasStore((state) => state.renameGroup);
  const toggleGroupCollapse = useCanvasStore((state) => state.toggleGroupCollapse);
  // 「重命名组」右键菜单请求：一次性通道，只有目标组命中布尔为 true（单点重渲染）
  const isRenameRequested = useCanvasStore(
    (state) => state.pendingGroupRenameNodeId === id,
  );
  const clearGroupRenameRequest = useCanvasStore((state) => state.clearGroupRenameRequest);
  // 拖入目标高亮：change controller 在拖成员悬停命中时写入（仅结果变化才写 store）。
  // 单值相等比较，只有本组命中/失焦才触发重渲染。
  const isDropTarget = useCanvasStore((state) => state.ui.groupDropTargetGroupId === id);
  // 拖组反馈：本组被拖动时背板边框/底板加深（见 buildSurfaceClass）
  const isDraggingSelf = useCanvasStore((state) => state.ui.groupDraggingId === id);

  // 成员计数：消费容器成员计数增量索引（AG-CN-014 / AG-CT-007——计数等派生量由变更驱动索引
  // 提供，本条对组与 Agent 容器同等生效；原「每实例订阅全图逐节点扫描」存量违规由此消除）。
  // selector 返回原始 number：成员关系未变时任意节点/图变更都被 Object.is 等值比较跳过。
  const memberCount = useCanvasStore((state) => selectContainerMemberCount(state, id));

  const [editingName, setEditingName] = useState<boolean>(false);
  const [nameDraft, setNameDraft] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingName]);

  const nodeDataTyped = nodeData as GroupNodeData;
  const collapsed = nodeDataTyped.collapsed;
  const name = nodeDataTyped.name;
  // 组色：undefined 回退默认色，保证视觉锚点始终存在
  const groupColor = nodeDataTyped.color ?? GROUP_DEFAULT_COLOR;
  // 配套文字档（浅 700 / 深 300 档）；组色 500 档永不直接做文字色
  const textColors = getGroupTextColors(groupColor);

  // 消费「重命名组」菜单请求：进入内联编辑态（编辑态 effect 负责聚焦与全选）
  useEffect(() => {
    if (!isRenameRequested) return;
    clearGroupRenameRequest();
    setNameDraft(name);
    setEditingName(true);
  }, [isRenameRequested, clearGroupRenameRequest, name]);

  const groupVarStyle: GroupCssVars = {
    '--group-color': groupColor,
    '--group-text-light': textColors.textLight,
    '--group-text-dark': textColors.textDark,
  };

  const handleStartRename = useCallback(() => {
    setNameDraft(name);
    setEditingName(true);
  }, [name]);

  const handleCommitRename = useCallback(() => {
    setEditingName(false);
    if (nameDraft !== name) {
      renameGroup(id, nameDraft);
    }
  }, [id, name, nameDraft, renameGroup]);

  const handleCancelRename = useCallback(() => {
    setEditingName(false);
    setNameDraft(name);
  }, [name]);

  // 组名编辑态是独立浮层（spec docs/editor/浮层堆栈管理.md 核心规则 6）：编辑激活即入栈，
  // Esc 先取消重命名、再按才轮到宿主（画布基底）。替代原先 input 的 onKeyDown Esc 分支；
  // `active` 与编辑态同源（state 驱动，卸载/提交/取消都会正确出栈）。
  useOverlayLayer({
    active: editingName,
    id: `group-rename:${id}`,
    onClose: handleCancelRename,
  });

  const handleToggleCollapse = useCallback(() => {
    toggleGroupCollapse(id);
  }, [id, toggleGroupCollapse]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleCommitRename();
      }
    },
    [handleCommitRename],
  );

  // LOD 降级判定：折叠卡片的屏幕空间尺寸（画布尺寸 × zoom）低于双阈值时降级为锚点块。
  // spec「折叠态 LOD 降级」（AG-CN-021）：触发维度是屏幕空间尺寸，不是 zoom。
  // width/height 由 ReactFlow 注入（派生尺寸经投影层）；初渲染时可能为 undefined，此时不降级。
  const screenW = typeof width === 'number' ? width * zoom : Number.POSITIVE_INFINITY;
  const screenH = typeof height === 'number' ? height * zoom : Number.POSITIVE_INFINITY;
  const isLodDegraded = collapsed && isContainerLodDegraded(screenW, screenH);

  // LOD 锚点点击：居中定位到组，zoom 反算以保证聚焦后脱离 LOD 降级态，组保持折叠态不展开。
  // 复用 useLocateToNode 主抽象（spec 要求），不引入独立 fitView 分支。
  // 聚焦 zoom 由 computeLodAnchorLocateZoom 按「聚焦后屏幕尺寸 ≥ LOD 阈值」反算得出，
  // 下限为定位主口径默认 zoom（1）。width/height 来自派生尺寸（与上方 LOD 判定同源），
  // 初渲染未收敛时（undefined）兜底为折叠卡片常量，保证反算始终有确定输入。
  const handleLodAnchorClick = useCallback(() => {
    const locateZoom = computeLodAnchorLocateZoom(
      typeof width === 'number' ? width : GROUP_COLLAPSED_MIN_WIDTH,
      typeof height === 'number' ? height : GROUP_COLLAPSED_HEIGHT,
    );
    locateToNode(id, 'lod-anchor-click', {
      zoom: locateZoom,
      duration: 300,
      select: true,
    });
  }, [id, locateToNode, width, height]);

  // 恒定 hairline：边框宽度取 1/zoom 画布 px，任意缩放下屏幕宽度恒为 1px（tldraw 惯例）。
  // 远缩放不再糊成噪点，近距缩放不增粗抢层级。
  const hairlineBorderWidth = zoom > 0 ? 1 / zoom : 1;
  // 屏幕恒定容器握把（AG-CN-019）：容器头屏幕高 < 28 或容器最短边 < 120 时显示。
  const showGrip =
    !collapsed &&
    shouldShowContainerGrip({
      headerScreenHeight: EXPANDED_HEADER_HEIGHT * zoom,
      screenWidth: screenW,
      screenHeight: screenH,
    });
  // 握把放置（above / 顶边翻转 inside）由 useContainerGripPlacement 的 primitive selector 承载。
  // 握把单击：居中定位到组（复用 useLocateToNode 主抽象，zoom 1 与定位主口径一致）
  const handleGripClick = useCallback(() => {
    locateToNode(id, 'container-grip-click', { zoom: 1, duration: 300, select: true });
  }, [id, locateToNode]);

  if (collapsed) {
    // LOD 降级态：屏幕固定尺寸锚点块（spec「折叠态 LOD 降级」）
    // 锚点块不随 zoom 继续缩小，保证可见/可识别/可点击；承载组色 + 组名首字。
    // 文字用固定近黑（--group-anchor-text）：500 档组色底压白字不达对比度。
    if (isLodDegraded) {
      const anchorSize = GROUP_LOD_ANCHOR_SCREEN_SIZE;
      const initial = (name && name.length > 0) ? name.charAt(0) : '?';
      // 反向缩放系数：抵消父级 RF viewport 的 zoom 缩放，让锚点块在屏幕上保持固定尺寸。
      // zoom 越小（缩得越远），反向系数越大（锚点块画布尺寸越大），屏幕投影恒定。
      const inverseScale = zoom > 0 ? 1 / zoom : 1;
      const canvasSize = anchorSize * inverseScale;
      // 居中于容器框：容器画布尺寸（width/height）与锚点画布尺寸均已知；
      // 尺寸未收敛（undefined）时按 0 处理，不留 NaN。
      const anchorLeft = typeof width === 'number' ? (width - canvasSize) / 2 : 0;
      const anchorTop = typeof height === 'number' ? (height - canvasSize) / 2 : 0;
      const anchorLabel = `${name || '未命名组'} · ${memberCount} 成员（拖动移动；单击定位）`;
      return (
        <div
          data-group-node={id}
          data-lod-anchor={id}
          data-testid="container-lod-anchor"
          role="button"
          tabIndex={0}
          aria-label={anchorLabel}
          className={cn(
            'pointer-events-auto flex cursor-pointer items-center justify-center rounded-md border shadow-sm transition-shadow',
            GROUP_BORDER_CLASS,
            selected &&
              'border-[var(--select-ring)] shadow-[0_0_0_2px_var(--select-ring),0_0_0_6px_var(--select-glow)]',
          )}
          style={{
            position: 'absolute',
            left: anchorLeft,
            top: anchorTop,
            width: canvasSize,
            height: canvasSize,
            backgroundColor: groupColor,
            fontSize: Math.floor(anchorSize * 0.5 * inverseScale),
            fontWeight: 700,
            borderWidth: hairlineBorderWidth,
            borderRadius: 10 * inverseScale,
            ...groupVarStyle,
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

    // 折叠态：信息卡片（spec：画布节点组.md「折叠态尺寸」）
    // 卡片尺寸由派生尺寸 selector 注入（外层 width/height），整块可交互；挂载时淡入。
    return (
      <div
        data-group-node={id}
        style={{ ...groupVarStyle, borderWidth: hairlineBorderWidth }}
        className={cn(
          'pointer-events-auto flex h-full w-full items-center gap-2 rounded-lg border pl-2 pr-3',
          'box-border',
          GROUP_BORDER_CLASS,
          'bg-[color-mix(in_srgb,var(--group-color)_12%,transparent)]',
          'shadow-[var(--shadow-sm)]',
          'animate-[iart-group-card-in_150ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none',
          GROUP_TRANSITION_CLASS,
          selected &&
            'border-[var(--select-ring)] shadow-[0_0_0_4px_var(--select-glow),var(--shadow-md)]',
          isDraggingSelf && 'cursor-grabbing',
        )}
      >
        <button
          type="button"
          onClick={handleToggleCollapse}
          className={cn(GROUP_BUTTON_CLASS, 'nodrag')}
          title="展开组"
        >
          <ExpandIcon />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-none text-foreground">
          {name || '未命名组'}
        </span>
        <span className={cn(GROUP_BADGE_CLASS, 'text-[11px]')} title={`${memberCount} 个成员`}>
          {memberCount}
        </span>
        {/* 折叠卡常显 2×3 握把点：提示整卡可拖（AG-CN-019） */}
        <GripDots size={2} />
      </div>
    );
  }

  return (
    // 外层容器：只负责定位与尺寸，透空（成员区域不接收指针事件），无背景色。
    // 围栏模型下，组的可交互实体收缩到标题栏，成员区域是"空的"。
    <div
      data-group-node={id}
      className="pointer-events-none h-full w-full"
      style={{ boxSizing: 'border-box', ...groupVarStyle }}
    >
      {/* 背板：1px 实线混合边框（hairline）+ 6% 组色底，纯视觉不接收点击。
          组已通过投影层 zIndex=-1 沉到成员之下，此层作为成员的底色背板，
          不会遮盖成员原色。点击成员间隙会穿过此层落回画布。 */}
      <div
        className={buildSurfaceClass(selected, isDropTarget, isDraggingSelf)}
        style={{ borderWidth: hairlineBorderWidth }}
        aria-hidden="true"
      />
      {/* 标题栏：组唯一可交互实体区域（全宽 32px 交互条）。折叠按钮、组名编辑、
          拖拽手柄均在此；左上 chip 只是视觉实体，条上空白处同样可拖组。 */}
      <div
        className="pointer-events-auto absolute left-0 right-0 top-0 flex items-start px-2"
        style={{ height: EXPANDED_HEADER_HEIGHT, paddingTop: 4 }}
      >
        <div className={buildChipClass(editingName)}>
          {/* 容器头常显 2×3 握把点（编辑态也保留）：提示标题条可拖（AG-CN-019） */}
          <GripDots size={2} />
          {editingName ? (
            <input
              ref={inputRef}
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={handleKeyDown}
              // nodrag nopan：编辑态输入框不触发拖组与平移
              className="nodrag nopan h-[18px] w-40 min-w-0 flex-1 border-none bg-transparent px-1 text-xs font-semibold text-foreground outline-none"
              placeholder="输入组名"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={handleToggleCollapse}
                // nodrag：折叠按钮是动作按钮，点击不应触发拖组
                className={cn(GROUP_BUTTON_CLASS, 'nodrag')}
                title="收起组"
              >
                <CollapseIcon />
              </button>
              <button
                type="button"
                onDoubleClick={handleStartRename}
                // 注意：组名按钮不加 nodrag，它是标题栏拖拽手柄的一部分，
                // 单击/拖拽用于拖动整个组；双击进入编辑态。
                className="min-w-0 flex-1 truncate border-none bg-transparent px-1 text-left text-xs font-semibold leading-none text-foreground"
                title="双击编辑组名"
              >
                {name || '未命名组'}
              </button>
            </>
          )}
          {/* 展开态也显示成员数徽章，保持展开/折叠两态的信息一致 */}
          <span className={cn(GROUP_BADGE_CLASS, 'text-[10px]')} title={`${memberCount} 个成员`}>
            {memberCount}
          </span>
        </div>
      </div>
      {/* 屏幕恒定容器握把（AG-CN-019）：放在容器框上方（成员区域之外），顶边时翻转进框内。
          按钮无 nodrag：拖动走 React Flow 既有节点拖动链路；单击（位移 ≤4px）定位到组。 */}
      {showGrip ? (
        <ContainerGrip
          containerId={id}
          label={name || '未命名组'}
          memberCount={memberCount}
          accent={groupColor}
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

const createFallbackGroupNode = (id: string) =>
  ({
    id,
    type: 'group' as const,
    position: { x: 0, y: 0 },
    data: {
      label: '节点组',
      description: undefined,
      runtimeRef: undefined,
      name: '',
      collapsed: false,
      color: undefined,
    },
    inputs: [],
    outputs: [],
    draggable: true,
    connectable: false,
    size: undefined,
    style: undefined,
    groupId: undefined,
  });

export const CollapseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 14 10 14 10 20" />
    <rect x="14" y="4" width="6" height="6" />
  </svg>
);

export const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 10 10 10 10 4" />
    <polyline points="20 10 14 10 14 4" />
    <polyline points="4 20 10 20 10 14" />
    <polyline points="20 20 14 20 14 14" />
  </svg>
);

export default GroupNode;
