'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import type { ParamTranslate } from '../promptDockParamModel';
import { inlineFields } from '../promptDockParamModel';
import { deriveFrameSpec, frameConsumedKeys } from '../promptDockFrameModel';
import { ParamFieldControl } from './PromptDockParamField';
import { PromptDockFrameControl } from './PromptDockFrameControl';

/**
 * 参数 inline 层（spec 节点参数呈现分层.md：高频子集、硬上限 4，完整集合在 Sheet）。
 * inline 子集由 promptDockParamModel 固定规则派生（schema 顺序前 4 个非媒体字段），
 * 控件与完整参数面板共用，两层条件呈现判据一致。
 *
 * 画幅组合控件：当画幅形态命中（constrained 单字段 / combo 比例+尺寸双字段）且
 * 消费字段进入 inline 子集时，行首以单个「画幅」chip 替代被消费字段的通用控件
 * （对齐原型 renderParamChips：consumed keys 不再渲染独立 chip）。
 */
export function PromptDockInlineParams({
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

  const fields = useMemo(() => inlineFields(entry), [entry]);
  const frameSpec = useMemo(() => deriveFrameSpec(entry), [entry]);

  // 画幅 chip 只在其消费字段确实处于 inline 子集时接管（其余字段保持通用控件派生规则不变）
  const consumedKeys = useMemo(
    () => (frameSpec === null ? null : new Set(frameConsumedKeys(frameSpec))),
    [frameSpec],
  );
  const frameTakesOver =
    frameSpec !== null && consumedKeys !== null && fields.some((field) => consumedKeys.has(field.fieldKey));
  const remainingFields = frameTakesOver
    ? fields.filter((field) => !consumedKeys?.has(field.fieldKey))
    : fields;

  if (fields.length === 0) return null;

  const setArgument = (fieldKey: string, next: unknown) => {
    setDraft({ arguments: { ...args, [fieldKey]: next } });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="promptdock-inline-params"
    >
      {frameTakesOver && frameSpec !== null ? (
        <PromptDockFrameControl
          spec={frameSpec}
          args={args}
          translate={translate}
          onChange={setArgument}
        />
      ) : null}
      {remainingFields.map((field) => (
        <ParamFieldControl
          key={field.fieldKey}
          field={field}
          value={args[field.fieldKey]}
          onValueChange={(next) => setArgument(field.fieldKey, next)}
          translate={translate}
          variant="compact"
        />
      ))}
    </div>
  );
}
