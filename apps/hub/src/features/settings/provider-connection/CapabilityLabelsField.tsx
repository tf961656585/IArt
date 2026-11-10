import { useState } from 'react';
import { Button, Input } from '@iart/ui';
import { FieldLabelRow } from './InfoHint';

/** 一条能力标签最多的字符数（按 Unicode 码点计，与 `capability_labels` 契约同口径，spec 48 §5）。 */
export const CAPABILITY_LABEL_MAX_LENGTH = 12;

/** 一条模型记录最多的能力标签条数（spec 48 §5）。 */
export const CAPABILITY_LABELS_MAX_COUNT = 10;

/**
 * 能力标签输入（spec 48 §6.2）：添加或修改模型时由用户手写「这个模型能产出什么素材」，
 * 例如「静态图」「动图」「矢量图」「首帧视频」。
 *
 * 只做输入期校验与去重提示；权威校验在写入侧（超限/超长整条拒绝并给原因，不静默截断）。
 * 标签是自由文本：软件不解释、不归一（大小写与同义不合并），只原样存下。
 */
export function CapabilityLabelsField({
  id,
  labels,
  onChange,
}: {
  id: string;
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (): void => {
    const value = draft.trim();
    if (value === '') {
      setError('先写一个标签再添加');
      return;
    }
    const length = [...value].length;
    if (length > CAPABILITY_LABEL_MAX_LENGTH) {
      setError(`每条标签最多 ${CAPABILITY_LABEL_MAX_LENGTH} 个字，这条是 ${length} 个`);
      return;
    }
    if (labels.includes(value)) {
      setError('这条标签已经加过了');
      return;
    }
    if (labels.length >= CAPABILITY_LABELS_MAX_COUNT) {
      setError(`最多 ${CAPABILITY_LABELS_MAX_COUNT} 条标签，先删掉一条再加`);
      return;
    }
    onChange([...labels, value]);
    setDraft('');
    setError(null);
  };

  const remove = (value: string): void => {
    onChange(labels.filter((item) => item !== value));
    setError(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <FieldLabelRow
        htmlFor={id}
        label="能力标签"
        hint={{
          subject: '能力标签',
          text: '说明这个模型能产出什么素材，例如静态图、动图、矢量图、首帧视频。最多 10 条，每条不超过 12 个字。选模型的人靠它判断该用哪个模型。',
        }}
      />
      {labels.length === 0 ? (
        <p className="text-2xs text-muted-foreground">还没填。不填也能用，但选模型时看不出它产出什么。</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-2xs text-foreground"
            >
              {label}
              <Button
                type="button"
                size="2xs"
                variant="ghost"
                aria-label={`移除标签「${label}」`}
                onClick={() => remove(label)}
              >
                ×
              </Button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={draft}
          placeholder="例如：静态图"
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // 回车只加标签，不提交外层表单（弹层底部按钮才是提交）。
            event.preventDefault();
            add();
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={add}>
          添加标签
        </Button>
      </div>
      {error === null ? null : <p role="alert" className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}
