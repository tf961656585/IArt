'use client';

import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { addAssetIdsToReferences } from '@/features/promptdock/referenceOps';
import { announceReferenceAddResult } from '@/features/promptdock/referenceFeedback';
import { cancelAgentToolCall } from '@/features/agent/agentSessionStore';
import { AssetPreviewDialog } from './AssetPreviewDialog';
import {
  PLACEHOLDER_BACKGROUND,
  ReferenceAssetChips,
  mediaAspectRatio,
  soloMediaCardStyle,
  useSessionMediaItems,
  type SessionMediaItem,
} from './AgentSessionMedia';
import { ToolCallEntryCard, ToolYoloCancelRow } from './AgentSessionToolEntries';
import { TOOL_STATUS_LABEL, isToolStatusGenerating, toolLabel } from './toolStatus';
import type { AlbumCall, AlbumImageCell, AlbumModel, AlbumStateCell } from './agentToolActivityModel';

/**
 * 连续生成相册（spec docs/agent/02「会话视图与多轮历史」2026-09-21 裁决，原型
 * `prototypes/agent-session-media-album/` 为形态对照）。
 *
 * 连续同名**图片生成工具**的调用序列聚合成一个相册组：组头轻行 + 自适应方格，
 * 替代逐调用「提案卡 + 结果卡」堆叠（压缩的是逐卡重复的头部行，不是 prompt ↔ 图的配对）。
 * prompt ↔ 图的配对四层独立可答：
 *   ① 组头（仅全组 distinct prompt = 1 时给一行摘要；≥ 2 宁沉默不误导）；
 *   ② 格 hover / 键盘 focus 的信息条（调用序号 · 图序 + prompt 截断）+ 非同调用的格加暗遮罩
 *      （同一次调用的格保持清晰，用空间表达归属）；
 *   ③ 预览翻页层（当前图完整 prompt + 该调用参考图 chips + ← → 翻页，起始索引由格 / 明细传入）；
 *   ④ 提示词明细（逐调用目录：序号 + prompt 全文 + 参考图 + 张数，点已完成行跳该调用首图）。
 *
 * 呈现口径：方格 `minmax(150px,1fr)` + gap 6px、cell 1:1 cover（缩略态裁切的构图判断移交预览层）；
 * 全组仅 1 张已就绪产物走真实比例独立带（1:1 会毁掉竖图构图）。生成中 / 失败 / 未执行的调用
 * 以状态占位格进相册（不进翻页序列），失败格可点开错误详情。**待审批提案不进相册**——
 * 审批行动入口必须立即可点，仍按提案卡渲染在相册之外，且不随相册收起。
 * yolo 自动执行中的调用在组头下给带调用序号的单条取消（格里没有卡头可挂，spec 04 单条取消）。
 *
 * 本组件只呈现 `AlbumModel`（模型由 `agentToolActivityModel` 算好）：不读 store、不发决裁、
 * 不建第二套引用入口（「用作参考」走既有 referenceOps，按素材 ID 直加，不依赖画布节点）。
 */

/** hover 信息条的 prompt 截断长度（原型口径 ~26 字）。 */
const PROMPT_TRUNCATE_LENGTH = 26;

/** aria 文案里的 prompt 截断长度（原型口径 ~24 字）。 */
const PROMPT_ARIA_LENGTH = 24;

/** 产物未就绪 / 破图占位文案（与媒体统一件同口径）。 */
const UNSETTLED_TEXT = '产物未就绪';
const FAILED_LOAD_TEXT = '无法加载';

/** 明细 / 预览里缺 prompt 时的说明（不臆造提示词）。 */
const NO_PROMPT_TEXT = '这次调用没有留下提示词';

/** 预览层左上角参考图 chips 的说明词。 */
const REFERENCE_LABEL = '参考图';

/** 预览地址缺失时的空态文案（画布上还没有这个产物；占位页不阻塞翻页）。 */
const PREVIEW_EMPTY_TEXT = '暂无图片输出';

/** 状态格的格内状态词与组头状态 fragment 用词（未执行 / 已取消档取既有状态词表）。 */
const STATE_CELL_WORD: Record<'generating' | 'failed', string> = {
  generating: '生成中',
  failed: '生成失败',
};

/** 组头失败 fragment 的用词（格子内说「生成失败」，组头计数说「N 失败」）。 */
const FAILED_FRAGMENT_WORD = '失败';

const truncateText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const promptOf = (call: AlbumCall): string => call.prompt ?? NO_PROMPT_TEXT;

/** 明细行的张数 / 状态 tag（与格内状态词同口径，不换一套说法）。 */
const callTagOf = (call: AlbumCall): string => {
  if (call.assetIds.length > 0) return `${String(call.assetIds.length)} 张`;
  if (isToolStatusGenerating(call.status)) return STATE_CELL_WORD.generating;
  if (call.status === 'failed') return FAILED_FRAGMENT_WORD;
  return TOOL_STATUS_LABEL[call.status];
};

/** 格的无障碍名（原型口径：调用序号 · 图序 + prompt 截断）。 */
const imageCellAriaLabel = (cell: AlbumImageCell): string =>
  `第 ${String(cell.call.ordinal)} 次调用第 ${String(cell.indexInCall)} 张，共 ${String(cell.countInCall)} 张，提示词：${truncateText(promptOf(cell.call), PROMPT_ARIA_LENGTH)}`;

/** 格的归属信息条：底部 scrim 两行（调用序号 · 图序 + prompt 截断），hover 与键盘 focus 等效。 */
const CellInfoBar = ({ head, call }: { head: string; call: AlbumCall }) => (
  <span
    aria-hidden="true"
    className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-px bg-(--scrim-70) px-[7px] py-[5px] text-left text-(--scrim-text) opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
  >
    <span className="text-[11px] font-medium tabular-nums">{head}</span>
    {call.prompt !== null ? (
      <span className="truncate text-[12px]">{truncateText(call.prompt, PROMPT_TRUNCATE_LENGTH)}</span>
    ) : null}
  </span>
);

/** 同调用兄弟格的暗遮罩（本格保持清晰：这几格是同一次调用，用空间表达归属）。 */
const SiblingDim = () => (
  <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-(--scrim-55) opacity-50" />
);

const CELL_CLASS = cn(
  'group relative aspect-square w-full overflow-hidden rounded-md border',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

/** 已就绪产物格：1:1 cover 缩略；产物未就绪 / 加载失败在格内占位（无预览出口，不给死路弹层）。 */
const AlbumImageCellView = ({
  cell,
  item,
  dimmed,
  onActivate,
  onOpen,
}: {
  cell: AlbumImageCell;
  item: SessionMediaItem | null;
  dimmed: boolean;
  onActivate: (toolCallId: string | null) => void;
  onOpen: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const faceUrl = item === null || item.unsettled || failed ? null : item.faceUrl;
  const previewable = item !== null && !item.unsettled && item.previewUrl !== null && !failed;
  const head = `第 ${String(cell.call.ordinal)} 次调用${
    cell.countInCall > 1 ? ` · 图 ${String(cell.indexInCall)}/${String(cell.countInCall)}` : ''
  }`;
  const content = (
    <>
      {faceUrl === null ? (
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center text-[11px]',
            failed ? 'text-(--st-failed-text)' : 'text-muted-foreground',
          )}
        >
          {failed ? FAILED_LOAD_TEXT : UNSETTLED_TEXT}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- 本地媒体（local-media 作用域地址），无优化管线可接
        <img
          src={faceUrl}
          alt=""
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {dimmed ? <SiblingDim /> : null}
      <CellInfoBar head={head} call={cell.call} />
    </>
  );
  const sharedProps = {
    onMouseEnter: () => onActivate(cell.call.toolCallId),
    onMouseLeave: () => onActivate(null),
    style: { background: PLACEHOLDER_BACKGROUND[item?.kind ?? 'image'] },
    'data-testid': 'agent-album-cell',
    'data-call-id': cell.call.toolCallId,
    'data-dimmed': dimmed ? 'true' : 'false',
  };

  if (!previewable) {
    // 产物未就绪 / 加载失败：格内占位，不给预览出口（spec 02：未就绪档无预览与引用出口）。
    return (
      <div
        role="img"
        aria-label={`第 ${String(cell.call.ordinal)} 次调用第 ${String(cell.indexInCall)} 张，共 ${String(cell.countInCall)} 张，${failed ? FAILED_LOAD_TEXT : UNSETTLED_TEXT}`}
        className={CELL_CLASS}
        {...sharedProps}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      onFocus={() => onActivate(cell.call.toolCallId)}
      onBlur={() => onActivate(null)}
      aria-label={`预览：${imageCellAriaLabel(cell)}`}
      className={cn(CELL_CLASS, 'cursor-zoom-in')}
      {...sharedProps}
    >
      {content}
    </button>
  );
};

/** 状态占位格：生成中（非按钮，不进翻页序列）/ 失败与未执行（可点开详情）。 */
const AlbumStateCellView = ({
  cell,
  dimmed,
  onActivate,
  onOpenDetail,
}: {
  cell: AlbumStateCell;
  dimmed: boolean;
  onActivate: (toolCallId: string | null) => void;
  onOpenDetail: () => void;
}) => {
  const word = cell.state === 'inactive' ? TOOL_STATUS_LABEL[cell.call.status] : STATE_CELL_WORD[cell.state];
  const head = `第 ${String(cell.call.ordinal)} 次调用 · ${
    cell.state === 'failed' ? FAILED_FRAGMENT_WORD : word
  }`;
  const face = (
    <>
      <span className="absolute inset-0 flex items-center justify-center gap-1 text-[11px]">
        {cell.state === 'generating' ? (
          <i
            aria-hidden="true"
            className="agent-session-breathe inline-block size-1.5 rounded-full bg-(--st-generating)"
          />
        ) : null}
        <span className={cell.state === 'failed' ? 'text-(--st-failed-text)' : 'text-muted-foreground'}>
          {word}
        </span>
      </span>
      {dimmed ? <SiblingDim /> : null}
      <CellInfoBar head={head} call={cell.call} />
    </>
  );
  const sharedProps = {
    onMouseEnter: () => onActivate(cell.call.toolCallId),
    onMouseLeave: () => onActivate(null),
    style: { background: PLACEHOLDER_BACKGROUND.image },
    'data-testid': 'agent-album-cell-state',
    'data-state': cell.state,
    'data-dimmed': dimmed ? 'true' : 'false',
  };

  if (cell.state === 'generating') {
    // 生成中格没有可点的出口：非按钮（占位底 + 呼吸点），也不进预览翻页序列。
    return (
      <div role="img" aria-label={`第 ${String(cell.call.ordinal)} 次调用，生成中，提示词：${truncateText(promptOf(cell.call), PROMPT_ARIA_LENGTH)}`} className={CELL_CLASS} {...sharedProps}>
        {face}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpenDetail}
      onFocus={() => onActivate(cell.call.toolCallId)}
      onBlur={() => onActivate(null)}
      aria-label={`第 ${String(cell.call.ordinal)} 次调用${word === STATE_CELL_WORD.failed ? '生成失败，点开错误详情' : `${word}，点开说明`}`}
      className={cn(CELL_CLASS, 'cursor-pointer')}
      {...sharedProps}
    >
      {face}
    </button>
  );
};

/** N=1 例外：真实比例独立带（宽 = min(100%, 240px × 比例)，1:1 裁切会毁掉竖图构图）。 */
const AlbumSoloCellView = ({
  cell,
  item,
  onOpen,
}: {
  cell: AlbumImageCell;
  item: SessionMediaItem | null;
  onOpen: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  // 比例探针：注册表缺尺寸时用媒体自身 naturalWidth / naturalHeight 回填（与媒体统一件同口径）。
  const [probedRatio, setProbedRatio] = useState<number | null>(null);
  const ratio = item === null ? null : probedRatio ?? mediaAspectRatio(item);
  const faceUrl = item === null || item.unsettled || failed ? null : item.faceUrl;
  const previewable = item !== null && !item.unsettled && item.previewUrl !== null && !failed;
  const widthCap = item === null ? undefined : soloMediaCardStyle([item]);
  const cellStyle = {
    ...widthCap,
    width: '100%',
    ...(ratio === null ? {} : { aspectRatio: String(ratio) }),
    background: PLACEHOLDER_BACKGROUND[item?.kind ?? 'image'],
  };
  const content = (
    <>
      {faceUrl === null ? (
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center text-[11px]',
            failed ? 'text-(--st-failed-text)' : 'text-muted-foreground',
          )}
        >
          {failed ? FAILED_LOAD_TEXT : UNSETTLED_TEXT}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- 本地媒体（local-media 作用域地址），无优化管线可接
        <img
          src={faceUrl}
          alt=""
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(event) => {
            const target = event.currentTarget;
            if (target.naturalWidth > 0 && target.naturalHeight > 0) {
              setProbedRatio(Number((target.naturalWidth / target.naturalHeight).toFixed(4)));
            }
          }}
          onError={() => setFailed(true)}
        />
      )}
      <CellInfoBar head={`第 ${String(cell.call.ordinal)} 次调用`} call={cell.call} />
    </>
  );

  return (
    <div className="flex" data-testid="agent-album-solo">
      {previewable ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`预览：${imageCellAriaLabel(cell)}`}
          data-testid="agent-album-cell"
          data-call-id={cell.call.toolCallId}
          className={cn(CELL_CLASS, 'aspect-auto cursor-zoom-in')}
          style={cellStyle}
        >
          {content}
        </button>
      ) : (
        // 产物未就绪 / 加载失败：真实比例独立带里也是格内占位，不给预览出口。
        <div
          role="img"
          aria-label={`第 ${String(cell.call.ordinal)} 次调用第 ${String(cell.indexInCall)} 张，共 ${String(cell.countInCall)} 张，${failed ? FAILED_LOAD_TEXT : UNSETTLED_TEXT}`}
          data-testid="agent-album-cell"
          data-call-id={cell.call.toolCallId}
          className={cn(CELL_CLASS, 'aspect-auto')}
          style={cellStyle}
        >
          {content}
        </div>
      )}
    </div>
  );
};

/** 提示词明细：逐调用目录（序号 + prompt 全文 + 参考图 chips + 张数），已完成行可跳该调用首图。 */
const AlbumDetail = ({
  calls,
  firstPageIndexByCallId,
  onJump,
}: {
  calls: readonly AlbumCall[];
  firstPageIndexByCallId: ReadonlyMap<string, number>;
  onJump: (previewIndex: number) => void;
}) => (
  <div
    className="flex flex-col gap-0.5 rounded-md border bg-secondary/30 p-1"
    data-testid="agent-album-detail"
    aria-label="提示词明细"
  >
    {calls.map((call) => {
      const jumpIndex = firstPageIndexByCallId.get(call.toolCallId);
      const tag = callTagOf(call);
      const row = (
        <>
          <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
            {String(call.ordinal).padStart(2, '0')}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[12px] break-words">{promptOf(call)}</span>
            {call.referenceAssetIds.length > 0 ? (
              <ReferenceAssetChips assetIds={call.referenceAssetIds} />
            ) : null}
          </span>
          <span className="flex-none text-[11px] text-muted-foreground">{tag}</span>
        </>
      );
      if (jumpIndex === undefined) {
        return (
          <div
            key={call.toolCallId}
            className="flex items-center gap-2 px-2 py-1.5"
            data-testid="agent-album-detail-row"
            data-call-id={call.toolCallId}
            aria-label={`第 ${String(call.ordinal)} 次调用，${tag}`}
          >
            {row}
          </div>
        );
      }
      return (
        <button
          key={call.toolCallId}
          type="button"
          onClick={() => onJump(jumpIndex)}
          data-testid="agent-album-detail-row"
          data-call-id={call.toolCallId}
          aria-label={`第 ${String(call.ordinal)} 次调用，${tag}，查看产物：${truncateText(promptOf(call), 20)}`}
          className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row}
          <span aria-hidden="true" className="flex-none text-[11px] text-(--st-generating-text)">
            查看 ›
          </span>
        </button>
      );
    })}
  </div>
);

/**
 * 当前页产物的「用作参考」：按**素材 ID** 直加（走既有 referenceOps 入口）——不要求画布上
 * 存在持有该产物的节点（存量会话产物不补落节点，spec docs/agent/04 · AG-EX-002）；
 * 准入不过给 toast 可见提示（不再静默丢弃）。页项无资产身份（不存在的形态）时不给出口。
 */
const AlbumPreviewReferenceButton = ({ item }: { item: SessionMediaItem }) => {
  const assetId = item.assetId;
  if (assetId === null) return null;
  return (
    <button
      type="button"
      onClick={() => announceReferenceAddResult(addAssetIdsToReferences([assetId]))}
      aria-label={`将「${item.name}」用作参考`}
      data-testid="agent-album-preview-reference"
      className="rounded border border-white/40 px-1.5 py-px transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      用作参考
    </button>
  );
};

/** 预览翻页层底部槽（契约 bottomStartSlot）：i / N + 上一张 / 下一张 + 用作参考，常驻可见。 */
const AlbumPreviewNav = ({
  index,
  total,
  referenceItem,
  onStep,
}: {
  index: number;
  total: number;
  referenceItem: SessionMediaItem | null;
  onStep: (delta: number) => void;
}) => (
  <div
    className="pointer-events-auto flex items-center gap-2 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white/85"
    data-testid="agent-album-preview-nav"
  >
    <span className="tabular-nums" data-testid="agent-album-preview-count">
      {index + 1} / {total}
    </span>
    <button
      type="button"
      disabled={index <= 0}
      onClick={() => onStep(-1)}
      aria-label="上一张"
      data-testid="agent-album-preview-prev"
      className="rounded px-1.5 py-px transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
    >
      ‹ 上一张
    </button>
    <button
      type="button"
      disabled={index >= total - 1}
      onClick={() => onStep(1)}
      aria-label="下一张"
      data-testid="agent-album-preview-next"
      className="rounded px-1.5 py-px transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
    >
      下一张 ›
    </button>
    {referenceItem !== null ? <AlbumPreviewReferenceButton item={referenceItem} /> : null}
  </div>
);

/** 翻页层归属信息：当前图的完整 prompt + 该次调用的参考图 chips（随翻页切换）。 */
const AlbumPageMeta = ({ page }: { page: AlbumImageCell }) => (
  <div className="flex flex-col gap-1.5 p-3" data-testid="agent-album-preview-meta">
    <p className="text-[12px] leading-[1.5] break-words text-foreground" data-testid="agent-album-preview-prompt">
      {promptOf(page.call)}
    </p>
    {page.call.referenceAssetIds.length > 0 ? (
      <div className="flex items-center gap-1.5">
        <span className="flex-none text-[11px] text-muted-foreground">{REFERENCE_LABEL}</span>
        <ReferenceAssetChips assetIds={page.call.referenceAssetIds} />
      </div>
    ) : null}
  </div>
);

/** 相册组：组头轻行 + 相册体（网格 / 独立带 + 提示词明细）+ 相册之外的待审批提案。 */
export function AgentSessionMediaAlbum({
  model,
  collapsed,
  onToggleCollapsed,
  inFlight,
  yoloMode,
}: {
  model: AlbumModel;
  /** 收起态由工具活动组持有（与条目卡组共用同一份折叠语义） */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  inFlight: boolean;
  yoloMode: boolean;
}) {
  const title = toolLabel(model.toolName);
  const [detailOpen, setDetailOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [errorCall, setErrorCall] = useState<AlbumCall | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  const previewAssetIds = useMemo(
    () => model.previewPages.map((page) => page.assetId),
    [model.previewPages],
  );
  const mediaItems = useSessionMediaItems(previewAssetIds);
  const firstPageIndexByCallId = useMemo(() => {
    const map = new Map<string, number>();
    for (const page of model.previewPages) {
      if (!map.has(page.call.toolCallId)) map.set(page.call.toolCallId, page.previewIndex);
    }
    return map;
  }, [model.previewPages]);

  const detailVisible = detailOpen && !collapsed;
  const detailId = `agent-album-detail-${model.calls[0]?.toolCallId ?? 'group'}`;
  const page = previewIndex === null ? null : model.previewPages[previewIndex] ?? null;
  const pageItem = page === null ? null : mediaItems[page.previewIndex] ?? null;

  const step = useCallback(
    (delta: number) => {
      setPreviewIndex((current) => {
        if (current === null) return current;
        const next = current + delta;
        return next < 0 || next >= model.previewPages.length ? current : next;
      });
    },
    [model.previewPages.length],
  );

  // ← → 翻页（契约「导航键盘交互」）：挂在预览对话框的 capture 阶段——导航槽在放大预览的
  // 按键宿主之外，只有对话框层能接住焦点落在导航控件上的方向键。含修饰键不消费（留给系统）；
  // Esc 不由这里处理（浮层栈统一分发）。
  const onPreviewKeyDown = useCallback(
    (event: ReactKeyboardEvent<Element>): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        step(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        step(1);
      }
    },
    [step],
  );

  const activate = useCallback((toolCallId: string | null) => setActiveCallId(toolCallId), []);
  const soloCell = model.soloCell;
  // yolo 自动执行中的单条取消：留在相册体之外（收起相册也收不掉——在跑的动作必须随时可取消）。
  const autoRunCalls = yoloMode && inFlight
    ? model.calls.filter((call) => isToolStatusGenerating(call.status))
    : [];

  return (
    <section
      className="flex flex-col border-t pt-2"
      data-testid="agent-session-tool-group"
      data-album="true"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={`${title} · ${String(model.callCount)} 次调用 ${String(model.imageCount)} 张图`}
    >
      {/* 组头轻行：工具名 + 「N 次调用 · M 张图」双计数 + 批次状态 + 折叠钮（收起只留这一行） */}
      <div className="flex items-center gap-1.5 pb-1.5">
        <button
          type="button"
          onClick={() => setDetailOpen((open) => !open)}
          aria-expanded={detailVisible}
          aria-controls={detailId}
          aria-label={`${title}，${String(model.callCount)} 次调用 ${String(model.imageCount)} 张图，切换提示词明细`}
          data-testid="agent-album-detail-toggle"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex-none text-[12px] font-medium text-foreground">{title}</span>
          <span className="flex-none text-muted-foreground" data-testid="agent-album-counts">
            {model.callCount} 次调用 · {model.imageCount} 张图
          </span>
          {model.generatingCalls > 0 ? (
            <span
              className="inline-flex flex-none items-center gap-1 text-(--st-generating-text)"
              data-testid="agent-album-generating-count"
            >
              <i
                aria-hidden="true"
                className="agent-session-breathe inline-block size-1.5 rounded-full bg-(--st-generating)"
              />
              {model.generatingCalls} {STATE_CELL_WORD.generating}
            </span>
          ) : null}
          {model.failedCalls > 0 ? (
            <span className="flex-none text-(--st-failed-text)" data-testid="agent-album-failed-count">
              {model.failedCalls} {FAILED_FRAGMENT_WORD}
            </span>
          ) : null}
          {collapsed ? (
            <span className="ml-auto flex-none text-muted-foreground" data-testid="agent-album-collapsed-count">
              {model.imageCount} 张图
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开相册' : '收起相册'}
          data-testid="agent-tool-group-toggle"
          className="flex-none text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconChevronDown
            size={12}
            aria-hidden="true"
            className={cn('transition-transform', collapsed && '-rotate-90')}
          />
        </button>
      </div>

      {/* 诚实判定：全组 distinct prompt = 1 才给这一行摘要；≥ 2 一行都不显示（宁沉默不误导） */}
      {!collapsed && model.singlePrompt !== null ? (
        <p
          className="truncate text-[12px] text-muted-foreground"
          data-testid="agent-album-summary"
          title={model.singlePrompt}
        >
          {model.singlePrompt}
        </p>
      ) : null}

      {/* 相册里每个格占不了卡头，yolo 单条取消带调用序号，指明取消的是哪一次调用 */}
      {autoRunCalls.map((call) => (
        <ToolYoloCancelRow
          key={call.toolCallId}
          label={`第 ${String(call.ordinal)} 次调用 · 已自动开始执行，可取消`}
          onCancel={() => cancelAgentToolCall(call.agentSessionId, call.toolCallId)}
        />
      ))}

      {collapsed ? null : (
        <div className="flex flex-col gap-1.5 pt-1.5 pb-1" data-testid="agent-album-body">
          {soloCell !== null ? (
            <AlbumSoloCellView
              cell={soloCell}
              item={mediaItems[soloCell.previewIndex] ?? null}
              onOpen={() => setPreviewIndex(soloCell.previewIndex)}
            />
          ) : model.cells.length > 0 ? (
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5"
              role="group"
              aria-label="相册产物网格"
              data-testid="agent-album-grid"
            >
              {model.cells.map((cell) =>
                cell.kind === 'image' ? (
                  <AlbumImageCellView
                    key={cell.key}
                    cell={cell}
                    item={mediaItems[cell.previewIndex] ?? null}
                    dimmed={activeCallId !== null && activeCallId !== cell.call.toolCallId}
                    onActivate={activate}
                    onOpen={() => setPreviewIndex(cell.previewIndex)}
                  />
                ) : (
                  <AlbumStateCellView
                    key={cell.key}
                    cell={cell}
                    dimmed={activeCallId !== null && activeCallId !== cell.call.toolCallId}
                    onActivate={activate}
                    onOpenDetail={() => setErrorCall(cell.call)}
                  />
                ),
              )}
            </div>
          ) : null}

          {detailVisible ? (
            <AlbumDetail
              calls={model.calls}
              firstPageIndexByCallId={firstPageIndexByCallId}
              onJump={setPreviewIndex}
            />
          ) : null}
        </div>
      )}

      {/* 待审批提案：不进相册、不随相册收起（审批行动入口必须立即可点） */}
      {model.pendingCalls.length > 0 ? (
        <div className="flex flex-col gap-2 pt-2.5" data-testid="agent-album-pending">
          {model.pendingCalls.map((message) => (
            <ToolCallEntryCard
              key={message.seq}
              message={message}
              status="proposed"
              inFlight={inFlight}
              yoloMode={yoloMode}
            />
          ))}
        </div>
      ) : null}

      <AssetPreviewDialog
        open={page !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
        mediaType={pageItem?.kind ?? 'image'}
        // 该页没有可预览地址（画布上还没有这个产物）时给空态占位：占位页仍在序列里，
        // 翻页键照常工作（契约「预览地址缺失或加载失败」不阻塞导航）。
        previewUrl={pageItem?.previewUrl ?? ''}
        emptyText={PREVIEW_EMPTY_TEXT}
        name={pageItem?.name ?? title}
        metaSlot={page === null ? undefined : <AlbumPageMeta page={page} />}
        bottomStartSlot={
          page === null ? undefined : (
            <AlbumPreviewNav
              index={page.previewIndex}
              total={model.previewPages.length}
              referenceItem={pageItem}
              onStep={step}
            />
          )
        }
        onKeyDownExtra={onPreviewKeyDown}
      />

      {/* 失败 / 未执行格点开的详情：同一预览壳的说明面（prompt + 原因），没有翻页序列 */}
      <AssetPreviewDialog
        open={errorCall !== null}
        onOpenChange={(open) => {
          if (!open) setErrorCall(null);
        }}
        mediaType="image"
        previewUrl={null}
        name={errorCall === null ? title : `${title} · 第 ${String(errorCall.ordinal)} 次调用`}
        faceSlot={
          <div
            className="flex h-40 w-full min-w-[280px] max-w-[520px] flex-col items-center justify-center gap-1 rounded-lg bg-(--scrim-55) text-(--scrim-text)"
            data-testid="agent-album-error-detail"
            data-call-id={errorCall?.toolCallId}
          >
            <span className="text-[13px]">
              {errorCall === null
                ? ''
                : errorCall.status === 'failed'
                  ? STATE_CELL_WORD.failed
                  : TOOL_STATUS_LABEL[errorCall.status]}
            </span>
            <span className="text-[11px] opacity-80">第 {errorCall?.ordinal ?? 0} 次调用</span>
          </div>
        }
        metaSlot={
          errorCall === null ? undefined : (
            <div className="flex flex-col gap-1.5 px-1 pt-3" data-testid="agent-album-error-meta">
              <p className="text-[12px] leading-[1.5] break-words">{promptOf(errorCall)}</p>
              {errorCall.reason !== null ? (
                <p className="text-[12px] leading-[1.5] break-words text-(--st-failed-text)">
                  {errorCall.reason}
                </p>
              ) : null}
              {errorCall.referenceAssetIds.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <span className="flex-none text-[11px] text-muted-foreground">{REFERENCE_LABEL}</span>
                  <ReferenceAssetChips assetIds={errorCall.referenceAssetIds} />
                </div>
              ) : null}
            </div>
          )
        }
      />
    </section>
  );
}

export default AgentSessionMediaAlbum;
