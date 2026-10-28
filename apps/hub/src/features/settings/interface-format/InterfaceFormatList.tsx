import { Button, cn, Input, SELECTION_SOFT_CLASSES } from '@iart/ui';
import type { InterfaceFormatDetail, InterfaceFormatSummary } from '@iart/contracts';

/**
 * 「接口格式」页左栏：预设 + 我的格式（docs/custom-providers/接口格式旅程-design.md §1.2）。
 *
 * 分组事实来自摘要的 `origin`：预设随软件分发、只读，只能「复制」成自己的；我的格式可编辑。
 * 行内不承载任何动作：复制 / 编辑 / 删除都属于「当前选中的那一个」，渲染在详情头部。
 * 这样列表行只有一个点击目标、一个 Tab 停靠点，也不再为动作条让出 38px 行高。
 *
 * 选中态口径（docs/ui-selection-standard.md §5.1 L1）：品牌实底 + 反白 + 600 字重；
 * hover 由 ghost 基类给中性提亮，选中行用 `hover:bg-primary` 钉住，不被 hover 冲淡。
 *
 * 每行第二处信息是**传输形态**（同步 / 异步）：它决定用户接下来要回答哪些问题，
 * 是扫描列表时唯一有决策价值的一列。摘要在契约里不带该事实，由详情装载结果提供；
 * 详情没读到时不猜（不默认写「同步」），只显示状态。
 */

/** 列表行的同步 / 异步标记：详情未就绪时返回 null（不猜）。 */
const formatModeLabel = (
  summary: InterfaceFormatSummary,
  detail: InterfaceFormatDetail | undefined,
): string | null => {
  if (summary.status !== 'ready' || detail === undefined) return null;
  return detail.transport?.async === null ? '同步' : '异步';
};

function FormatRow({
  summary,
  detail,
  selected,
  onSelect,
}: {
  summary: InterfaceFormatSummary;
  detail: InterfaceFormatDetail | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const mode = formatModeLabel(summary, detail);
  const secondary = selected ? 'text-[var(--selection-fg)]' : 'text-muted-foreground';
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      data-format-row={summary.format_id}
      onClick={onSelect}
      className={cn(
        'h-auto w-full flex-col items-start justify-start gap-1 px-3 py-2 text-left',
        selected ? SELECTION_SOFT_CLASSES : 'bg-elevated',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{summary.display_name}</span>
        {summary.status !== 'ready' ? (
          <span className={cn('shrink-0 text-2xs', secondary)}>还没就绪</span>
        ) : mode === null ? null : (
          <span className={cn('shrink-0 text-2xs', secondary)}>{mode}</span>
        )}
      </span>
      <span className={cn('w-full truncate text-2xs', secondary)}>{summary.format_id}</span>
    </Button>
  );
}

export function InterfaceFormatList({
  formats,
  details,
  selectedId,
  query,
  onSelect,
}: {
  formats: InterfaceFormatSummary[];
  details: ReadonlyMap<string, InterfaceFormatDetail>;
  selectedId: string | null;
  query: string;
  onSelect: (formatId: string) => void;
}) {
  const keyword = query.trim().toLowerCase();
  const matched = keyword === ''
    ? formats
    : formats.filter(
        (item) => item.display_name.toLowerCase().includes(keyword)
          || item.format_id.toLowerCase().includes(keyword),
      );
  const presets = matched.filter((item) => item.origin === 'preset');
  const userFormats = matched.filter((item) => item.origin === 'user');

  const renderGroup = (
    label: string,
    items: InterfaceFormatSummary[],
    emptyText: string,
  ) => (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {items.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <FormatRow
              key={item.format_id}
              summary={item}
              detail={details.get(item.format_id)}
              selected={item.format_id === selectedId}
              onSelect={() => onSelect(item.format_id)}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      data-interface-format-rail
      role="group"
      aria-label="接口格式列表"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto rounded-md border border-border bg-muted/40 p-2"
    >
      {formats.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">还没有可用的接口格式。</p>
      ) : matched.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">没有匹配的接口格式。</p>
      ) : (
        <>
          {renderGroup('预设', presets, '没有匹配的预设。')}
          {renderGroup('我的格式', userFormats, '还没有自己创建的接口格式。')}
        </>
      )}
    </div>
  );
}

/** 列表区顶部的搜索框（页面头承载，左栏与页面过滤口径唯一）。 */
export function InterfaceFormatSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="搜索接口格式"
      aria-label="搜索接口格式"
      className="w-56"
    />
  );
}
