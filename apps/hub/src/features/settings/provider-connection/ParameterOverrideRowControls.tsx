import { useEffect, useState } from 'react';
import { Input } from '@iart/ui';
import type { FamilyTemplateOfficialField, OfficialParameterOverride } from '@iart/contracts';

/**
 * 参数编辑器共用的行内小件与素材位行。
 *
 * 素材位行只放「发送名称」与「最多几张」两个维度：是否接收这类素材由模型表单里的勾选清单
 * （`accepted_media_slots`）决定，这里不再提供启用开关——两处都能改会造出二义；
 * 枚举/默认值/预设对素材位不适用，故一律不渲染。
 */

export const MEDIA_MAX_FILES_HINT = '最多几张要填 1 或更大的整数';

/** 可摘除的覆盖维度（field_key 是身份，不在其列）。 */
type OfficialOverrideKey = Exclude<keyof OfficialParameterOverride, 'field_key'>;

/** 摘掉一个覆盖维度；摘完只剩 field_key 的条目由 applyOfficialChange 统一清理。 */
export const withoutKey = <K extends OfficialOverrideKey>(
  entry: OfficialParameterOverride,
  key: K,
): OfficialParameterOverride => {
  const next: OfficialParameterOverride = { ...entry };
  delete next[key];
  return next;
};

/** 失焦 / 回车才提交的输入框（官方别名、自定义发送名称用）：输入过程不改数据，提交时由调用方决定空值与默认值的语义。 */
export function CommitInput({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      setDraft(value);
      return;
    }
    onCommit(trimmed);
    // 没被接受的提交（如自定义参数清空发送名称）把草稿拉回当前值；
    // 被接受的提交随后由 props 变化经 useEffect 同步
    setDraft(value);
  };

  return (
    <Input
      aria-label={ariaLabel}
      className="h-7 flex-1 text-xs"
      value={draft}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

/** 一小行字段标签（控件自身带 aria-label，可见文字只负责让界面读得懂）。 */
export function MiniLabel({ text }: { text: string }) {
  return <span className="w-16 shrink-0 text-2xs text-muted-foreground">{text}</span>;
}

/** 行内即时提示（与提交拦截是同一份数据，见 collectOverrideIssues）。 */
export function IssueLine({ messages, id }: { messages: string[]; id?: string }) {
  if (messages.length === 0) return null;
  const lines = messages.map((message) => (
    <p key={message} role="alert" className="text-2xs text-destructive">
      {message}
    </p>
  ));
  // 只有新调用点（接口格式参数表）需要 id 供 aria-describedby；其余调用点保持原 DOM，不改样式
  return id === undefined ? <>{lines}</> : <div id={id}>{lines}</div>;
}

/** 素材位张数输入：只接受正整数；0 / 负数 / 小数留在输入框里并给行内提示，不进数据。 */
function MediaMaxFilesInput({
  value,
  defaultValue,
  ariaLabel,
  onCommit,
}: {
  value: number | undefined;
  defaultValue: number;
  ariaLabel: string;
  onCommit: (next: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
    setInvalid(false);
  }, [value]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        aria-label={ariaLabel}
        aria-invalid={invalid}
        className="h-7 w-24 text-xs"
        value={draft}
        placeholder={String(defaultValue)}
        inputMode="numeric"
        autoComplete="off"
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const trimmed = raw.trim();
          if (trimmed === '') {
            setInvalid(false);
            onCommit(undefined);
            return;
          }
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed < 1) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onCommit(parsed);
        }}
      />
      {invalid ? (
        <p role="alert" className="text-2xs text-destructive">
          {MEDIA_MAX_FILES_HINT}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 素材位行：只有发送名称与最多几张。
 *
 * `onChange` 与普通参数行同形（对一条覆盖做一次改动），由编辑器统一走 applyOfficialChange。
 */
export function MediaSlotParameterRow({
  field,
  override,
  issues,
  onChange,
}: {
  field: FamilyTemplateOfficialField;
  override: OfficialParameterOverride | undefined;
  issues: string[];
  onChange: (mutate: (entry: OfficialParameterOverride) => OfficialParameterOverride) => void;
}) {
  const defaultMaxFiles = field.media_max_files ?? 1;
  const commitWireName = (raw: string): void => {
    onChange((entry) =>
      raw === '' || raw === field.wire_name ? withoutKey(entry, 'wire_name') : { ...entry, wire_name: raw },
    );
  };
  const commitMaxFiles = (next: number | undefined): void => {
    onChange((entry) =>
      next === undefined || next === defaultMaxFiles
        ? withoutKey(entry, 'media_max_files')
        : { ...entry, media_max_files: next },
    );
  };

  return (
    <div role="group" aria-label={field.label} className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{field.label}</span>
      </div>
      <div className="flex items-center gap-2">
        <MiniLabel text="发送名称" />
        <CommitInput
          value={override?.wire_name ?? ''}
          placeholder={field.wire_name}
          ariaLabel={`「${field.label}」的发送名称`}
          onCommit={commitWireName}
        />
      </div>
      <div className="flex items-start gap-2">
        <MiniLabel text="最多几张" />
        <MediaMaxFilesInput
          value={override?.media_max_files}
          defaultValue={defaultMaxFiles}
          ariaLabel={`「${field.label}」的最多几张`}
          onCommit={commitMaxFiles}
        />
      </div>
      <IssueLine messages={issues} />
    </div>
  );
}
