import { HelpCircle } from 'lucide-react';
import { Label, Tooltip, TooltipContent, TooltipTrigger } from '@iart/ui';

/**
 * 字段级「需要时才出现」的解释入口。
 *
 * 口径：界面默认不印解释文字，字段旁边一个「?」——鼠标悬停或键盘聚焦才展开气泡。
 * 之所以不把说明直接写在字段下方，是因为同类产品的这些概念（服务地址、密钥、
 * 模型 ID）用户已经熟悉，常驻解释只会把表单撑长、盖住真正要做的事。
 *
 * 只在「不看说明就会填错」时才挂载；能靠占位符或标签自解释的字段不要加。
 */
export function InfoHint({ text, subject }: { text: string; subject: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 圆形解释钮：**图标 14px 不变，命中区 24px**（2026-10-19）。
            原先命中区与图标同为 14px，是视觉尺寸当命中区用的典型缺陷——14px 的点按目标
            远低于可达性底线，触控板/触屏上几乎点不中。现在用负外边距把多出来的命中区
            向四周撑开（`-m-1` + `p-1` 抵消），**不改变所在行的高度与文字对齐**，
            因此不会把字段行撑高，也就绕开了原本「按钮最小档 32px 放不下」的顾虑。
            口径见 docs/hub/visual-design.md §8.6 律一（chip 内微动作命中区 ≥24px）。 */}
        <button
          type="button"
          aria-label={`${subject}说明`}
          className="-m-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 字段标签 + 可选解释入口。表单里统一用它，避免每处重复拼 Label 与间距。
 */
export function FieldLabelRow({
  htmlFor,
  label,
  hint,
}: {
  htmlFor: string;
  label: string;
  hint?: { text: string; subject: string } | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {hint ? <InfoHint text={hint.text} subject={hint.subject} /> : null}
    </div>
  );
}
