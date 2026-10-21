'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { usePromptDockStore } from '../promptDockStore';
import { describeDeploymentFailure } from '../deploymentFailureText';
import { rejudgeReferencesForModel } from '../referenceSlotModel';

type PromptDockHeaderProps = {
  catalog: PromptDockCatalogEntry[];
  selectedModelId: string | null;
  selectedEntry: PromptDockCatalogEntry | null;
};

/**
 * 顶带上下文组（生成形态，docs/editor/dock-布局规范.md R8 读序第二组）：
 * 模型选择与 active deployment 合并为带状态 pip 的单个 trigger
 * （原型 .picker-trigger：底座 + status-pip + model_id 直显 + chev）。
 *
 * pip 即部署状态：绿（--pip-configured）= 可提交，红（--pip-invalid）= 不可提交，
 * 失败原因在 title，提交时由 preflight 反馈带兜底完整原因（拍板项 2026-09-20：
 * 不接受常驻原因文字，换取顶带紧凑）。读屏经 pip 的 role=img + aria-label 获知状态。
 *
 * 模型选择只选 model_id，直显不翻译，列表来自 Backend 可执行目录。
 * 切换模型时：保留 prompt；不兼容引用由前置校验呈现为阻断项（不静默删除）。
 * 前导分隔符由顶带容器渲染，本组件不含分隔符。
 */
export function PromptDockHeader({
  catalog,
  selectedModelId,
  selectedEntry,
}: PromptDockHeaderProps) {
  const { t } = useTranslation('components');
  const setDraft = usePromptDockStore((s) => s.setDraft);
  const references = usePromptDockStore((s) => s.draft.references);

  const modelOptions = useMemo(
    () =>
      catalog
        .map((entry) => ({ modelId: entry.model_id }))
        .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    [catalog],
  );

  /** 目录只回原因码，现场文案由本端按码渲染（见 deploymentFailureText） */
  const failureText = selectedEntry === null
    ? ''
    : describeDeploymentFailure(selectedEntry.deployment.failure_code);

  const deployable = selectedEntry?.deployment.deployable ?? null;

  return (
    <Select
      value={selectedModelId ?? ''}
      onValueChange={(modelId) => {
        const entry = catalog.find((e) => e.model_id === modelId) ?? null;
        // 模型专属参数重置为新模型默认值；prompt 与引用保留（不兼容引用由校验呈现）。
        // 用途随模型切换重判一次（设计 §4.5）：同名素材位原样保留、原用途不存在时按新模型的
        // 默认落位重判、原本未指定的也重判一次。不重判会让「用不了」的用途一路拖到后端才失败。
        setDraft({
          modelId,
          modelVersion: entry?.model_version ?? null,
          arguments:
            entry?.parameter_schema.default_values &&
            Object.keys(entry.parameter_schema.default_values).length > 0
              ? { ...entry.parameter_schema.default_values }
              : {},
          references: rejudgeReferencesForModel(references, entry),
        });
      }}
    >
      <SelectTrigger
        size="sm"
        className="dock-form-content h-7 max-w-[240px] min-w-0 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 text-xs font-medium text-foreground whitespace-nowrap hover:border-input"
        title={deployable === false ? failureText : undefined}
        data-testid="promptdock-model-select"
        aria-label={t('modelSelector.placeholder', '选择模型')}
      >
        {selectedEntry !== null ? (
          <span
            role="img"
            aria-label={
              deployable ? t('promptDock.deploymentReady', '可以生成') : failureText
            }
            data-testid="promptdock-deployment-status"
            className={cn(
              'size-1.5 flex-none rounded-full',
              deployable ? 'bg-(--pip-configured)' : 'bg-(--pip-invalid)',
            )}
          />
        ) : null}
        {/* model_id 直显（原型 .model-id：190px 内省略；宽度由 trigger max-w 钳制） */}
        <span className="min-w-0 truncate">
          <SelectValue placeholder={t('modelSelector.placeholder', '选择模型')} />
        </span>
      </SelectTrigger>
      {/* 弹层口径同原型（composer.js placePopover "up" / composer.css .popover）：
          Dock 浮于画布底部 → 一律向上弹、左缘贴 trigger、间隙 6px、窗口 8px 内钳制；
          z-dock-popover 必须高于 Dock 卡片 z-dock，否则弹层与 Dock 重叠区被卡片盖住
          （docs/editor/elevation-z-model.md）；
          宽度按原型裁定固定 328px，窄窗口钳制到视口内。 */}
      <SelectContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="z-dock-popover w-[328px] min-w-[8rem] max-w-[calc(100vw-16px)]"
      >
        {modelOptions.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t('promptDock.noModels', '还没有可用的模型。关掉这个窗口后到主窗口「设置 → 服务商与模型」添加')}
          </div>
        ) : (
          modelOptions.map((option) => (
            <SelectItem key={option.modelId} value={option.modelId}>
              {option.modelId}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
