import { useState, type ReactNode } from 'react';
import { Button, Card, CardContent, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@iart/ui';
import { ChevronDown } from 'lucide-react';

/**
 * 设置页分区统一容器（spec docs/hub/hub-information-architecture.md §5.3）：
 * 承载子单元标题、描述、可选操作槽（右上角）、可选可折叠能力与内容区。
 * 消除各分区手写 section 头的重复，统一标题/描述/间距。
 * 视觉令牌复用 @iart/ui Card 习语，取值唯一事实源 docs/hub/visual-design.md §7.1 字号阶梯
 * px 定案表与 §8.5 密度：Card `gap-0 p-0` + CardContent `p-4 gap-3`，
 * title `text-sm font-semibold`，description `text-xs text-muted-foreground`。
 */
export interface SettingsSectionProps {
  /** 分区标题（统一 text-sm font-semibold，消费方不得内联覆盖） */
  title: string;
  /** 分区描述（统一 text-xs text-muted-foreground） */
  description?: string;
  /** 右上角操作槽（如刷新按钮） */
  action?: ReactNode;
  /** 启用可折叠能力（低频高级配置子单元使用，如 ModelDeployment） */
  collapsible?: boolean;
  /** 可折叠时的初始展开态（默认 true） */
  defaultOpen?: boolean;
  /** 内容区 */
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  action,
  collapsible = false,
  defaultOpen = true,
  children,
}: SettingsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <Card className="gap-0 p-0">
        <CardContent className="flex flex-col gap-3 p-4">
          {/* 动作就近排列（gap-3 = 12px，visual-design §8.5 拉空上限）：不用 justify-between，
              标题与同行动作之间不得出现 >240px 的无内容横档（「服务商」↔「刷新」曾拉空 ~640px） */}
          <div className="flex items-start gap-3">
            <div>
              <h2 className="text-sm font-semibold">{title}</h2>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          {children}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 p-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-w-0 flex-1 items-start justify-between gap-2 rounded-md px-2 py-1 text-left"
              >
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  {description ? (
                    <span className="block text-xs font-normal text-muted-foreground">{description}</span>
                  ) : null}
                </span>
                <ChevronDown
                  className={cn(
                    'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                    open ? 'rotate-0' : '-rotate-90',
                  )}
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          <CollapsibleContent className="flex flex-col gap-3">{children}</CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
