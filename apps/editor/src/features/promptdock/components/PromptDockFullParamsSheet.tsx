'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { usePromptDockStore } from '../promptDockStore';
import type { ParamTranslate } from '../promptDockParamModel';
import {
  inlineFields,
  paramFormFields,
  resolveParamLabel,
} from '../promptDockParamModel';
import { ParamFieldControl } from './PromptDockParamField';

/**
 * 完整参数面板（Sheet，spec 节点参数呈现分层.md「完整参数面板层」）。
 *
 * 承载全量模型参数（媒体上传字段除外，其由参考区承载）；向上弹出浮层，不占参数行空间，
 * 内容超面板可视高度时内部纵向滚动。入口按钮「完整参数」始终存在（完整可达判据）。
 * inline 层参数在此同样可见（inline 是真子集），两层共用 ParamFieldControl 保证条件判据一致。
 */
export function PromptDockFullParamsSheet({
  entry,
}: {
  entry: PromptDockCatalogEntry | null;
}) {
  const args = usePromptDockStore((s) => s.draft.arguments);
  const setDraft = usePromptDockStore((s) => s.setDraft);
  const { t } = useTranslation();

  const translate = useMemo<ParamTranslate>(
    () => (key, fallback) => {
      if (!key) return fallback;
      const resolved = t(key, { defaultValue: fallback });
      return resolved === key ? fallback : resolved;
    },
    [t],
  );

  const allFields = useMemo(() => paramFormFields(entry), [entry]);
  const inlineSet = useMemo(
    () => new Set(inlineFields(entry).map((f) => f.fieldKey)),
    [entry],
  );

  // 「已改 N」= 与 schema default_value 不一致的字段数（对齐原型 mod-dot 语义）。
  const modifiedCount = useMemo(
    () =>
      allFields.filter((field) => {
        const current = args[field.fieldKey];
        if (current === undefined) return false;
        return JSON.stringify(current) !== JSON.stringify(field.defaultValue);
      }).length,
    [allFields, args],
  );

  if (!entry) {
    // 未选模型时无参数可呈现，但完整面板入口按「始终存在」保留禁用态。
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        className="h-7 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground"
        data-testid="promptdock-sheet-trigger"
      >
        完整参数
      </Button>
    );
  }

  const resetAll = () => {
    const nextArgs = { ...args };
    for (const field of allFields) {
      if (field.defaultValue === undefined) {
        delete nextArgs[field.fieldKey];
      } else {
        nextArgs[field.fieldKey] = field.defaultValue;
      }
    }
    setDraft({ arguments: nextArgs });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 rounded-lg px-2 text-[11px] font-medium text-foreground hover:bg-secondary"
          data-testid="promptdock-sheet-trigger"
        >
          <span aria-hidden="true">⚙</span>
          完整参数
          <span className="text-muted-foreground"> {allFields.length}</span>
          {modifiedCount > 0 ? (
            <span
              className="ml-0.5 inline-flex items-center gap-0.5 text-(--st-generating-text)"
              title={`已修改 ${modifiedCount} 项`}
            >
              · {modifiedCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="z-dock-popover w-[360px] max-w-[calc(100vw-16px)] p-0"
        data-testid="promptdock-full-params"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium">
            完整参数
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              {allFields.length} 项 · {entry.model_id}
            </span>
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={modifiedCount === 0}
              onClick={resetAll}
              className="h-6 px-2 text-[11px] text-muted-foreground"
            >
              重置全部
            </Button>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-3 py-2">
          {allFields.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              该模型无可调参数
            </div>
          ) : (
            <div className="flex flex-col">
              {allFields.map((field) => {
                const label = resolveParamLabel(translate, field.label, field.fieldKey);
                return (
                  <div
                    key={field.fieldKey}
                    className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-b-0"
                  >
                    <span className="flex items-center gap-1.5 text-xs text-foreground">
                      {label}
                      {inlineSet.has(field.fieldKey) ? (
                        <span
                          className="text-[10px] text-muted-foreground"
                          title="同时呈现在参数行"
                        >
                          · 常用
                        </span>
                      ) : null}
                    </span>
                    <div className="flex min-w-0 items-center justify-end">
                      <ParamFieldControl
                        field={field}
                        value={args[field.fieldKey]}
                        onValueChange={(next) =>
                          setDraft({ arguments: { ...args, [field.fieldKey]: next } })
                        }
                        translate={translate}
                        variant="sheet"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
