'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID,
  TEXT_INPUT_AI_EDIT_TEMPLATE_OPTIONS,
  isTextInputAiEditTemplateId,
  type TextInputAiEditTemplateId,
} from '@/features/canvas/nodes/textInput/textInputAiEditTemplates';
import { runTextInputAiEdit } from '@/features/canvas/services/textInputAiEditService';
import { SystemPromptStore } from '@/features/canvas/services/systemPromptStore';
import { focusHubModelProviders } from '@/features/promptdock/hubFocus';
import type { SystemPromptItem } from '@iart/contracts';

export type TextInputAiEditModelOption = {
  modelId: string;
  modelLabel: string;
};

export interface TextInputAiEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceText: string;
  onApply: (nextText: string) => void;
  enableTemplates: boolean | undefined;
  modelOptions: TextInputAiEditModelOption[];
}

const NO_SYSTEM_PROMPT_VALUE = '__none__';

export const TextInputAiEditDialog = memo(function TextInputAiEditDialog({
  open,
  onOpenChange,
  sourceText,
  onApply,
  enableTemplates = false,
  modelOptions,
}: TextInputAiEditDialogProps) {
  const { t } = useTranslation('components');
  const [userInstruction, setUserInstruction] = useState('');
  const [resultText, setResultText] = useState('');
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [systemPromptItems, setSystemPromptItems] = useState<SystemPromptItem[]>([]);
  const [selectedSystemPromptId, setSelectedSystemPromptId] = useState(NO_SYSTEM_PROMPT_VALUE);
  const [templateId, setTemplateId] = useState<TextInputAiEditTemplateId>(
    TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID,
  );

  useEffect(() => {
    if (!open) {
      setTemplateId(TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID);
      setResultText('');
      setUsedModel(null);
      setErrorText(null);
    }
  }, [open]);

  // 打开时加载系统提示词库（用户级资源，AI 编辑可选用）。
  useEffect(() => {
    if (!open) return;
    let active = true;
    void SystemPromptStore.getAll({ force: false, keyword: undefined }).then((items) => {
      if (!active) return;
      setSystemPromptItems(items);
    });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const stillExists = modelOptions.some((option) => option.modelId === selectedModelId);
    if (stillExists) return;
    const first = modelOptions[0];
    setSelectedModelId(first !== undefined ? first.modelId : '');
  }, [modelOptions, open, selectedModelId]);

  const resolvedTemplateId = enableTemplates
    ? templateId
    : TEXT_INPUT_AI_EDIT_TEMPLATE_NONE_ID;

  const selectedTemplateOption = useMemo(
    () => TEXT_INPUT_AI_EDIT_TEMPLATE_OPTIONS.find((option) => option.id === templateId),
    [templateId],
  );
  const selectedTemplateDescription =
    selectedTemplateOption !== null && selectedTemplateOption !== undefined
      ? selectedTemplateOption.description
      : undefined;

  const selectedModel = useMemo(
    () => modelOptions.find((option) => option.modelId === selectedModelId),
    [modelOptions, selectedModelId],
  );

  const handleRun = useCallback(async () => {
    if (selectedModel === undefined) {
      setErrorText(t('textInputAiEdit.errorNoModel', '请先选择模型'));
      return;
    }
    setLoading(true);
    setErrorText(null);
    setResultText('');
    try {
      const result = await runTextInputAiEdit({
        modelId: selectedModel.modelId,
        systemPromptId:
          selectedSystemPromptId === NO_SYSTEM_PROMPT_VALUE ? undefined : selectedSystemPromptId,
        sourceText,
        userInstruction,
        templateId: resolvedTemplateId,
        onToken: (text) => {
          setResultText((current) => current + text);
        },
      });
      setUsedModel(selectedModel.modelLabel || result.modelId);
      setResultText(result.content);
    } catch (error) {
      console.error('[TextInputAiEditDialog] run failed:', error);
      setUsedModel(null);
      setErrorText(t('textInputAiEdit.errorRunFailed', '这次没能改出来，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [resolvedTemplateId, selectedModel, selectedSystemPromptId, sourceText, t, userInstruction]);

  const canApply = resultText.trim().length > 0 && !loading;
  const hasModelOptions = modelOptions.length > 0;
  const runDisabled = loading || !hasModelOptions;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="wide">
        <DialogHeader>
          <DialogTitle>{t('textInputAiEdit.title', 'AI 修改')}</DialogTitle>
          <DialogDescription>
            {t(
              'textInputAiEdit.description',
              '写下你想怎么改，点「开始修改」生成结果，可编辑后再覆盖原文。',
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody variant="scroll" className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="text-ai-edit-model">{t('textInputAiEdit.modelLabel', '模型')}</Label>
            {hasModelOptions ? (
              <Select
                value={selectedModelId}
                onValueChange={setSelectedModelId}
                disabled={loading}
              >
                <SelectTrigger
                  id="text-ai-edit-model"
                  className="w-full"
                  size="default"
                >
                  <SelectValue placeholder={t('modelSelector.placeholder', '选择模型')} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.modelId} value={option.modelId}>
                      {option.modelLabel} · {option.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <span>{t('textInputAiEdit.noModels', '当前没有可用的对话模型。到主窗口「设置 → 服务商与模型」添加后，重新打开本窗口再试。')}</span>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto w-fit p-0 text-xs"
                  onClick={focusHubModelProviders}
                >
                  {t('promptDock.goFix', '去添加')}
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="text-ai-edit-system-prompt">
              {t('textInputAiEdit.systemPromptLabel', '角色设定（可选）')}
            </Label>
            <Select
              value={selectedSystemPromptId}
              onValueChange={setSelectedSystemPromptId}
              disabled={loading}
            >
              <SelectTrigger
                id="text-ai-edit-system-prompt"
                className="w-full"
                size="default"
              >
                <SelectValue placeholder={t('textInputAiEdit.systemPromptNone', '未选择角色设定')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SYSTEM_PROMPT_VALUE}>
                  {t('textInputAiEdit.systemPromptNone', '未选择角色设定')}
                </SelectItem>
                {systemPromptItems.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {t('textInputAiEdit.noSystemPrompts', '还没有可用的角色设定')}
                  </div>
                ) : (
                  systemPromptItems.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="text-ai-edit-instruction">
              {t('textInputAiEdit.instructionLabel', '你想怎么改')}
            </Label>
            <Textarea
              id="text-ai-edit-instruction"
              value={userInstruction}
              onChange={(e) => setUserInstruction(e.target.value)}
              placeholder={t(
                'textInputAiEdit.instructionPlaceholder',
                '例如：更具体、更电影感；加上镜头与光线；把语气改得更克制……',
              )}
              rows={3}
              className="resize-none"
            />
          </div>

          {enableTemplates ? (
            <div className="space-y-2">
              <Label htmlFor="text-ai-edit-template">
                {t('textInputAiEdit.templateLabel', '模板')}
              </Label>
              <Select
                value={templateId}
                onValueChange={(value) => {
                  if (isTextInputAiEditTemplateId(value)) {
                    setTemplateId(value);
                  }
                }}
                disabled={loading}
              >
                <SelectTrigger
                  id="text-ai-edit-template"
                  className="w-56"
                  size="default"
                >
                  <SelectValue placeholder={t('textInputAiEdit.templatePlaceholder', '选择模板')} />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_INPUT_AI_EDIT_TEMPLATE_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplateDescription ? (
                <p className="text-xs text-muted-foreground">
                  {selectedTemplateDescription}
                </p>
              ) : null}
            </div>
          ) : null}

          {errorText ? <div className="text-sm text-destructive">{errorText}</div> : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="text-ai-edit-result">
                {t('textInputAiEdit.resultLabel', '修改结果')}
              </Label>
              {usedModel ? (
                <span className="text-xs text-muted-foreground">
                  {t('textInputAiEdit.usedModel', '使用模型')}：{usedModel}
                </span>
              ) : null}
            </div>
            <Textarea
              id="text-ai-edit-result"
              value={resultText}
              onChange={(e) => setResultText(e.target.value)}
              placeholder={t(
                'textInputAiEdit.resultPlaceholder',
                'AI 修改后的内容会显示在这里，你也可以直接编辑。',
              )}
              rows={10}
              className="min-h-[180px]"
            />
          </div>
        </DialogBody>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {t('textInputAiEdit.cancel', '取消')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={runDisabled}
            onClick={() => void handleRun()}
          >
            {loading
              ? t('textInputAiEdit.running', '修改中…')
              : resultText.trim()
                ? t('textInputAiEdit.regenerate', '重新生成')
                : t('textInputAiEdit.start', '开始修改')}
          </Button>
          <Button
            type="button"
            disabled={!canApply}
            onClick={() => {
              onApply(resultText);
            }}
          >
            {t('textInputAiEdit.apply', '覆盖原文')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export default TextInputAiEditDialog;
