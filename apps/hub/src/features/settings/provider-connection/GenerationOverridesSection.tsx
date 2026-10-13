import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@iart/ui';
import { ChevronDown } from 'lucide-react';
import type { FamilyTemplateParameterDescriptor, ParameterOverrides } from '@iart/contracts';
import {
  collectOverrideIssues,
  ParameterOverridesEditor,
  type ParameterOverrideIssue,
} from './ParameterOverridesEditor';

/**
 * 「高级参数自定义」折叠区（docs/custom-providers/生成模型参数高级自定义-design.md §3.4）。
 *
 * 添加弹层与编辑弹层共用：默认收起，展开时拉一次族模板参数描述（读不到时该区禁用并
 * 显示一行原因，基础动作不受影响；重新展开会再试一次）。添加弹层在接口类型还没选时
 * 传 `pending`：这不是装载失败，是指引还没到能判断的一步，按专属指引呈现。
 * 参数编辑器是纯受控组件，本文件只负责装载与三态呈现，不掺入提交逻辑——
 * 提交时是否拦截由弹层按 `issues` 判定。
 */

type TemplateLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; descriptor: FamilyTemplateParameterDescriptor }
  | { kind: 'failed' };

export type GenerationOverridesSectionState = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** 族模板参数描述的装载三态：折叠区按它呈现加载中 / 失败 / 编辑器 */
  template: TemplateLoad;
  value: ParameterOverrides;
  setValue: Dispatch<SetStateAction<ParameterOverrides>>;
  /** 客户端可判定的必然失败（发送名称格式、占用、空枚举、默认值越界）；权威校验在 Runtime Backend */
  issues: ParameterOverrideIssue[];
};

export function useGenerationOverridesSection(
  loadDescriptor: () => Promise<FamilyTemplateParameterDescriptor>,
  initialValue: ParameterOverrides,
): GenerationOverridesSectionState {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<TemplateLoad>({ kind: 'idle' });
  const [value, setValue] = useState<ParameterOverrides>(initialValue);

  const ensureLoaded = (): void => {
    if (template.kind === 'loading' || template.kind === 'loaded') return;
    setTemplate({ kind: 'loading' });
    loadDescriptor()
      .then((descriptor) => setTemplate({ kind: 'loaded', descriptor }))
      .catch((error: unknown) => {
        console.debug('[generation-overrides] 读不到族模板参数描述，高级自定义保持不可用', error);
        setTemplate({ kind: 'failed' });
      });
  };

  return {
    open,
    // 展开即装载：放在事件回调里做，不进 setState 更新函数（更新函数必须保持纯）
    setOpen: (next) => {
      const resolved = typeof next === 'function' ? next(open) : next;
      setOpen(resolved);
      if (resolved) ensureLoaded();
    },
    value,
    setValue,
    template,
    // 模板已装载时才算得出即时提示；读不到时不拦提交（权威校验在 Runtime Backend）
    issues: template.kind === 'loaded' ? collectOverrideIssues(template.descriptor, value) : [],
  };
}

export function GenerationOverridesSection({
  state,
  pending = false,
}: {
  state: GenerationOverridesSectionState;
  /** 接口类型还没选（创建表单空态起步）：优先于装载三态呈现，指引先选接口类型 */
  pending?: boolean;
}) {
  return (
    <Collapsible open={state.open} onOpenChange={state.setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // 行承载容器呼吸档（visual-design §8.6 律二）：px-3 py-2
          className="h-auto w-full justify-between rounded-md px-3 py-2"
        >
          高级参数自定义
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              state.open ? 'rotate-0' : '-rotate-90',
            )}
            aria-hidden="true"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        {pending ? (
          <p className="text-xs text-muted-foreground">先选好接口类型，再看能调哪些参数。</p>
        ) : state.template.kind === 'loading' ? (
          <p className="text-xs text-muted-foreground">正在读取可调的参数…</p>
        ) : state.template.kind === 'failed' ? (
          <p className="text-xs text-muted-foreground">
            暂时读不到可调的参数，这项设置用不了；收起再展开可以再试。其他设置不受影响。
          </p>
        ) : state.template.kind === 'loaded' ? (
          <ParameterOverridesEditor
            descriptor={state.template.descriptor}
            value={state.value}
            onChange={state.setValue}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
