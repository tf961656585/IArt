import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@iart/ui';
import type {
  CustomParameterField,
  FamilyTemplateOfficialField,
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
  OfficialParameterOverride,
  ParameterOverrides,
  ParameterOverridesValue,
} from '@iart/contracts';
import {
  GENERATION_WIRE_NAME_PATTERN,
  InterfaceFormatBodyPathSchema,
  interfaceFormatBodyPathsOverlap,
  isForbiddenRequestHeaderName,
  isValidHttpHeaderName,
  isValidQueryParamName,
  normalizeHeaderName,
} from '@iart/contracts';
import {
  EnumDefaultSelect,
  NO_DEFAULT_OPTION,
  NumberValueInput,
  OptionListEditor,
  sameValue,
  valueKey,
} from '../components/ParameterValueControls';
import { InfoHint } from './InfoHint';
import {
  CommitInput,
  IssueLine,
  MEDIA_MAX_FILES_HINT,
  MediaSlotParameterRow,
  MiniLabel,
  withoutKey,
} from './ParameterOverrideRowControls';

/**
 * 参数覆盖编辑器（docs/custom-providers/生成模型参数高级自定义-design.md §3.4）。
 *
 * 纯受控组件：只把用户在界面上的改动整理成 `ParameterOverrides` 交回 `onChange`，
 * 自己不发任何请求；数据形状即设计 §3.2，官方区一行对应模板的一个参数，自定义区一条
 * 对应一个服务商私有参数。添加弹层与编辑弹层复用同一组件，避免同一套编辑能力两处实现。
 *
 * 校验分层（设计 §3.3）：这里的即时提示只是前置反馈——发送名称格式、占用查重、空枚举、
 * 默认值越界这类**客户端可判定的必然失败**在提交前拦下（ui-copy-standard 落地口径第 6 条）；
 * 权威校验唯一实现在 Runtime Backend（设计 §3.5），保存失败的原因由调用方原样透进弹层。
 */

/** 提交前拦截用的逐条原因；`target` 指认出问题的行（官方参数 field_key / 自定义参数 custom:序号）。 */
export type ParameterOverrideIssue = {
  target: string;
  message: string;
};

// ---------------------------------------------------------------------------
// 即时提示文案（同一句话同时给编辑器行内提示与提交拦截，不另写一份）
// ---------------------------------------------------------------------------

const WIRE_NAME_FORMAT_HINT = '发送名称只能用小写字母、数字、下划线，且要以小写字母开头';
/** 别名按字段当前落点判合法性；提示与后端同一套名称规则（请求体路径 / 查询参数名 / 请求头名）。 */
const ALIAS_FORMAT_HINTS = {
  body: '发送名称格式不对：请用字母、数字、_、-，层级之间用点号分隔',
  query: '查询参数名称格式不对：只能用字母、数字、下划线、点、短横线和方括号',
  header: '请求头名称只能用字母、数字和 - _ 等符号，不能有空格或冒号',
} as const;
const HEADER_FORBIDDEN_HINT = '这个请求头由软件自动管理（如 Content-Type、Authorization），请换一个名称';
const WIRE_NAME_TAKEN_HINT = '这个发送名称不能用了：可能和别的参数重名，或已被模型自带的内容占用。换一个。';
/** 官方参数的发出位置（别名只改名，不改位置）。 */
const WIRE_LOCATION_LABELS = {
  body: '请求体',
  query: '查询参数',
  header: '请求头',
} as const;
const WIRE_NAME_REQUIRED_HINT = '要给这个参数一个发送名称';
const LABEL_REQUIRED_HINT = '显示名不能为空';
const ENUM_EMPTY_HINT = '下拉选择至少要有一个可选值';
const DEFAULT_NOT_IN_OPTIONS_HINT = '默认值要从可选值里选';
const OFFICIAL_SECTION_HINT =
  '「发送名称」是发给服务商的参数名。服务商的参数名跟官方不一样时才改；可选值和默认值也按服务商支持的来。素材行里的「最多几张」按这家服务商一次最多收几张来填。';
const CUSTOM_LIMIT = 8;
const CUSTOM_LIMIT_HINT = `自定义参数最多 ${CUSTOM_LIMIT} 个`;

/** 空覆盖（每次新对象，调用方可自由改写不共享引用）。 */
export const emptyParameterOverrides = (): ParameterOverrides => ({ official: [], custom: [] });

// ---------------------------------------------------------------------------
// 纯函数：覆盖数据的小工具（组件与校验共用，不碰 React 状态）
// ---------------------------------------------------------------------------

/** 除 field_key 外什么都没改的覆盖条目等于没有覆盖：从数组里拿掉，请求体保持最小。 */
const isNoopOfficialEntry = (entry: OfficialParameterOverride): boolean =>
  Object.keys(entry).every((key) => key === 'field_key');

/** 对官方参数的一条覆盖做一次改动；改动后不再表达任何覆盖（只剩 field_key）时整条移除。 */
const applyOfficialChange = (
  overrides: ParameterOverrides,
  fieldKey: string,
  mutate: (entry: OfficialParameterOverride) => OfficialParameterOverride,
): ParameterOverrides => {
  const index = overrides.official.findIndex((entry) => entry.field_key === fieldKey);
  const current = index >= 0 ? overrides.official[index] : undefined;
  const mutated = mutate(current ?? { field_key: fieldKey });
  const withoutRow = overrides.official.filter((_, i) => i !== index);
  if (isNoopOfficialEntry(mutated)) {
    return index >= 0 ? { ...overrides, official: withoutRow } : overrides;
  }
  const official = index >= 0
    ? [...withoutRow.slice(0, index), mutated, ...withoutRow.slice(index)]
    : [...overrides.official, mutated];
  return { ...overrides, official };
};

/** 两条枚举列表是否完全一致（顺序也算）：一致即「没改过」，不产生覆盖。 */
const sameSequence = (a: ParameterOverridesValue[], b: ParameterOverridesValue[]): boolean =>
  a.length === b.length && a.every((item, i) => {
    const other = b[i];
    return other !== undefined && sameValue(item, other);
  });

/** 官方参数当前生效的发送名称（别名优先，回落模板默认）。 */
const effectiveOfficialWireName = (field: FamilyTemplateOfficialField, override: OfficialParameterOverride | undefined): string =>
  override?.wire_name ?? field.wire_name;

/**
 * 同一个名字是否指向同一个线路位置（判据与后端同一套）：
 * - 请求体按键路径判定——同一棵树上的祖孙路径写同一个对象；
 * - 查询参数按名称全等；
 * - 请求头名不区分大小写（HTTP 口径，与共享校验的 `normalizeHeaderName` 同源）。
 *
 * 命名空间不同则互不相干：同一个名字在请求体与查询参数里是两个不同的字段。
 */
const sameWireName = (
  location: FamilyTemplateOfficialField['wire_location'],
  left: string,
  right: string,
): boolean => {
  if (location === 'body') return interfaceFormatBodyPathsOverlap(left, right);
  if (location === 'header') return normalizeHeaderName(left) === normalizeHeaderName(right);
  return left.trim() === right.trim();
};

/** 别名在当前落点下的格式原因；`null` = 合法。 */
const aliasFormatIssue = (
  location: FamilyTemplateOfficialField['wire_location'],
  name: string,
): string | null => {
  if (location === 'body') {
    return InterfaceFormatBodyPathSchema.safeParse(name).success ? null : ALIAS_FORMAT_HINTS.body;
  }
  if (location === 'query') {
    return isValidQueryParamName(name) ? null : ALIAS_FORMAT_HINTS.query;
  }
  if (!isValidHttpHeaderName(name)) return ALIAS_FORMAT_HINTS.header;
  if (isForbiddenRequestHeaderName(name)) return HEADER_FORBIDDEN_HINT;
  return null;
};

// ---------------------------------------------------------------------------
// 纯函数：素材位行的生效范围（族能力 × 当前勾选）
// ---------------------------------------------------------------------------

/**
 * 当前真正生效的官方参数行：素材位行只在**该位已被勾选**时出现。
 *
 * 描述符是**族级**事实（这个接口格式一共能表达哪几行），不掌握某条记录勾了哪些位；
 * 「哪些行该出现」由弹层当前的勾选清单决定。两处各自过滤会漂移，因此只在这里实现。
 *
 * 隐藏的行同时不参与客户端查重与占用表——后端按本次勾选的模板校验，未勾选位的发送名
 * 并不占名，客户端按未过滤的清单算会拒绝一个本来合法的名字。
 */
export const visibleOfficialFields = (
  descriptor: FamilyTemplateParameterDescriptor,
  liveMediaSlotIds: readonly GenerationMediaSlotId[],
): FamilyTemplateOfficialField[] => {
  const live = new Set(liveMediaSlotIds);
  return descriptor.official_fields.filter(
    (field) => field.media_slot_id === undefined || live.has(field.media_slot_id),
  );
};

/**
 * 提交用的覆盖：丢掉「本该出现的行已经不存在」的官方条目。
 *
 * 判据只有一条——该条目的字段键属于一个**当前未勾选**的素材位。取消勾选后行从界面上
 * 消失，用户填过的值仍留在弹层状态里（同一次弹层内勾回来还能看到），但不进请求体：
 * 后端按本次勾选的模板校验覆盖，带上它必然被整次拒绝。
 *
 * 映射缺失（模板没读到）时原样返回——此时提交已被产物位装载状态拦下，不会走到这里。
 */
export const pruneOfficialOverridesForLiveMediaSlots = (
  overrides: ParameterOverrides,
  liveMediaSlotIds: readonly GenerationMediaSlotId[],
  fieldKeyBySlotId: Readonly<Partial<Record<GenerationMediaSlotId, string>>>,
): ParameterOverrides => {
  const live = new Set(liveMediaSlotIds);
  const dormantFieldKeys = new Set<string>();
  for (const [slotId, fieldKey] of Object.entries(fieldKeyBySlotId)) {
    if (fieldKey === undefined || fieldKey.length === 0) continue;
    if (!live.has(slotId as GenerationMediaSlotId)) dormantFieldKeys.add(fieldKey);
  }
  if (dormantFieldKeys.size === 0) return overrides;
  return {
    ...overrides,
    official: overrides.official.filter((entry) => !dormantFieldKeys.has(entry.field_key)),
  };
};

// ---------------------------------------------------------------------------
// 纯函数：逐条原因收集（编辑器行内提示与提交拦截共用同一份实现）
// ---------------------------------------------------------------------------

/**
 * 收集当前覆盖里客户端可判定的必然失败。
 *
 * 只检查形状与本地已知信息（格式、占用、枚举非空、默认值落在新合法集内、素材张数为正整数）；
 * 「field_key 必须命中模板」「覆盖维度必须与该字段能力匹配」等语义校验
 * 唯一实现在 Runtime Backend（设计 §3.5），这里不复制第二份。
 */
export const collectOverrideIssues = (
  descriptor: FamilyTemplateParameterDescriptor,
  overrides: ParameterOverrides,
  liveMediaSlotIds: readonly GenerationMediaSlotId[],
): ParameterOverrideIssue[] => {
  const issues: ParameterOverrideIssue[] = [];
  const officialByKey = new Map(overrides.official.map((entry) => [entry.field_key, entry]));
  // 只算当前生效的行：未勾选位的行不出现在界面上，也不占发送名（后端按本次勾选校验）。
  const fields = visibleOfficialFields(descriptor, liveMediaSlotIds);

  // 占用表：保留键 + 启用中官方参数的生效发送名称 + 自定义参数的发送名称。
  // 每个命名空间一张表：同一个名字在请求体与查询参数里互不相干。
  // 停用中的参数不占名（它的规则已整体移除）。
  const owners: Record<FamilyTemplateOfficialField['wire_location'], Array<{ name: string; owner: string }>> = {
    body: [],
    query: [],
    header: [],
  };
  const claim = (location: FamilyTemplateOfficialField['wire_location'], name: string, owner: string): void => {
    owners[location].push({ name, owner });
  };
  for (const name of descriptor.reserved_wire_names.body) claim('body', name, 'reserved');
  for (const name of descriptor.reserved_wire_names.query) claim('query', name, 'reserved');
  for (const name of descriptor.reserved_wire_names.header) claim('header', name, 'reserved');
  for (const field of fields) {
    const override = officialByKey.get(field.field_key);
    if (override?.enabled === false) continue;
    claim(field.wire_location, effectiveOfficialWireName(field, override), `official:${field.field_key}`);
  }
  // 自定义参数固定发到请求体（记录级不给位置选择，与后端口径一致）。
  overrides.custom.forEach((entry, index) => claim('body', entry.wire_name, `custom:${index}`));
  const takenByOthers = (location: FamilyTemplateOfficialField['wire_location'], name: string, self: string): boolean =>
    owners[location].some((entry) => entry.owner !== self && sameWireName(location, entry.name, name));

  for (const field of fields) {
    const override = officialByKey.get(field.field_key);
    if (override === undefined) continue;
    if (override.enabled === false) continue;
    if (override.wire_name !== undefined) {
      const formatIssue = aliasFormatIssue(field.wire_location, override.wire_name);
      if (formatIssue !== null) {
        issues.push({ target: field.field_key, message: formatIssue });
      } else if (takenByOthers(field.wire_location, override.wire_name, `official:${field.field_key}`)) {
        issues.push({ target: field.field_key, message: WIRE_NAME_TAKEN_HINT });
      }
    }
    // 素材位行只有发送名称与最多几张两个维度：枚举/默认值对它不适用，张数另判正整数
    if (field.media_slot_id !== undefined) {
      const maxFiles = override.media_max_files;
      if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
        issues.push({ target: field.field_key, message: MEDIA_MAX_FILES_HINT });
      }
      continue;
    }
    if (field.enum_options.length > 0) {
      const options = override.enum_options ?? field.enum_options;
      const effectiveDefault = override.default_value ?? field.default_value;
      if (
        effectiveDefault !== null &&
        effectiveDefault !== undefined &&
        !options.some((option) => sameValue(option, effectiveDefault))
      ) {
        issues.push({ target: field.field_key, message: DEFAULT_NOT_IN_OPTIONS_HINT });
      }
    }
  }

  overrides.custom.forEach((entry, index) => {
    for (const message of customFieldIssues(entry, (name) => takenByOthers('body', name, `custom:${index}`))) {
      issues.push({ target: `custom:${index}`, message });
    }
  });
  return issues;
};

/** 一条自定义参数的逐条原因；`isNameTaken` 回答「这个名字是否已被别的参数占用」。 */
export const customFieldIssues = (
  entry: CustomParameterField,
  isNameTaken: (name: string) => boolean,
): string[] => {
  const issues: string[] = [];
  if (entry.label.trim() === '') {
    issues.push(LABEL_REQUIRED_HINT);
  }
  if (entry.wire_name.trim() === '') {
    issues.push(WIRE_NAME_REQUIRED_HINT);
  } else if (!GENERATION_WIRE_NAME_PATTERN.test(entry.wire_name)) {
    issues.push(WIRE_NAME_FORMAT_HINT);
  } else if (isNameTaken(entry.wire_name)) {
    issues.push(WIRE_NAME_TAKEN_HINT);
  }
  if (entry.value_type === 'enum') {
    const options = entry.enum_options ?? [];
    if (options.length === 0) {
      issues.push(ENUM_EMPTY_HINT);
    } else {
      const currentDefault = entry.default_value;
      if (currentDefault !== undefined && !options.some((option) => sameValue(option, currentDefault))) {
        issues.push(DEFAULT_NOT_IN_OPTIONS_HINT);
      }
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// 官方参数行
// ---------------------------------------------------------------------------

const KEEP_DEFAULT_OPTION = '__keep_default__';

function OfficialParameterRow({
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
  const enabled = override?.enabled !== false;
  const selectLike = field.enum_options.length > 0;
  const currentOptions = override?.enum_options ?? field.enum_options;
  const effectiveDefault = override?.default_value ?? field.default_value;
  const defaultInOptions =
    effectiveDefault !== null &&
    effectiveDefault !== undefined &&
    currentOptions.some((option) => sameValue(option, effectiveDefault));

  const toggleEnabled = (next: boolean): void => {
    onChange((entry) => (next ? withoutKey(entry, 'enabled') : { ...entry, enabled: false }));
  };
  const commitWireName = (raw: string): void => {
    onChange((entry) => {
      if (raw === '' || raw === field.wire_name) return withoutKey(entry, 'wire_name');
      return { ...entry, wire_name: raw };
    });
  };
  const setEnumOptions = (next: ParameterOverridesValue[]): void => {
    onChange((entry) => {
      if (sameSequence(next, field.enum_options)) return withoutKey(entry, 'enum_options');
      const currentDefault = entry.default_value;
      // 缩小后的合法集容不下现有默认值覆盖时把它摘掉：留着必然被拒，摘掉后由「默认值」提示引导重选
      const dropDefault =
        currentDefault !== undefined && !next.some((option) => sameValue(option, currentDefault));
      const withOptions = { ...entry, enum_options: next };
      return dropDefault ? withoutKey(withOptions, 'default_value') : withOptions;
    });
  };
  const setDefault = (next: ParameterOverridesValue | null): void => {
    onChange((entry) => (next === null ? withoutKey(entry, 'default_value') : { ...entry, default_value: next }));
  };
  const togglePreset = (group: 'resolution' | 'aspect', key: string): void => {
    const allKeys = group === 'resolution'
      ? field.resolution_presets.map((preset) => preset.key)
      : field.aspect_presets.map((preset) => preset.key);
    const current = group === 'resolution'
      ? override?.resolution_preset_keys ?? null
      : override?.aspect_preset_keys ?? null;
    const selected = new Set(current ?? allKeys);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    const nextKeys = allKeys.filter((candidate) => selected.has(candidate));
    onChange((entry) => {
      if (nextKeys.length === allKeys.length) {
        return withoutKey(entry, group === 'resolution' ? 'resolution_preset_keys' : 'aspect_preset_keys');
      }
      return group === 'resolution'
        ? { ...entry, resolution_preset_keys: nextKeys }
        : { ...entry, aspect_preset_keys: nextKeys };
    });
  };

  const decodeDefault = new Map(currentOptions.map((option) => [valueKey(option), option]));

  // 行承载可见性由表面阶梯承担、不靠 border（visual-design §8.6 律二 + §9.1 边框退场）；内距已合规
  return (
    <div className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnabled}
          aria-label={`启用参数「${field.label}」`}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{field.label}</span>
      </div>
      {enabled ? (
        <>
          <div className="flex items-center gap-2">
            <MiniLabel text="发送到" />
            <span className="text-xs text-muted-foreground">{WIRE_LOCATION_LABELS[field.wire_location]}</span>
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
          {selectLike ? (
            <>
              <div className="flex items-start gap-2">
                <MiniLabel text="可选值" />
                <div className="min-w-0 flex-1">
                  <OptionListEditor
                    options={currentOptions}
                    onChange={setEnumOptions}
                    addInputAriaLabel={`「${field.label}」的新可选值`}
                    addButtonAriaLabel={`为「${field.label}」添加可选值`}
                    removeButtonAriaPrefix={`删掉「${field.label}」的可选值`}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <MiniLabel text="默认值" />
                <Select
                  value={
                    defaultInOptions && effectiveDefault !== null && effectiveDefault !== undefined
                      ? valueKey(effectiveDefault)
                      : KEEP_DEFAULT_OPTION
                  }
                  onValueChange={(next) => {
                    if (next === KEEP_DEFAULT_OPTION) {
                      setDefault(null);
                      return;
                    }
                    const decoded = decodeDefault.get(next);
                    if (decoded !== undefined) setDefault(decoded);
                  }}
                >
                  <SelectTrigger size="sm" className="w-44" aria-label={`「${field.label}」的默认值`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={KEEP_DEFAULT_OPTION}>保持默认</SelectItem>
                    {currentOptions.map((option) => (
                      <SelectItem key={valueKey(option)} value={valueKey(option)}>
                        {String(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}
          {field.resolution_presets.length > 0 ? (
            <PresetGroup
              fieldLabel={field.label}
              groupLabel="分辨率档位"
              presets={field.resolution_presets}
              selectedKeys={override?.resolution_preset_keys ?? null}
              onToggle={(key) => togglePreset('resolution', key)}
            />
          ) : null}
          {field.aspect_presets.length > 0 ? (
            <PresetGroup
              fieldLabel={field.label}
              groupLabel="画面比例"
              presets={field.aspect_presets}
              selectedKeys={override?.aspect_preset_keys ?? null}
              onToggle={(key) => togglePreset('aspect', key)}
            />
          ) : null}
          <IssueLine messages={issues} />
        </>
      ) : null}
    </div>
  );
}

function PresetGroup({
  fieldLabel,
  groupLabel,
  presets,
  selectedKeys,
  onToggle,
}: {
  fieldLabel: string;
  groupLabel: string;
  presets: { key: string; label: string }[];
  selectedKeys: string[] | null;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <MiniLabel text={groupLabel} />
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {presets.map((preset) => {
          const checked = selectedKeys === null || selectedKeys.includes(preset.key);
          const inputId = `${fieldLabel}-${groupLabel}-${preset.key}`;
          return (
            <label key={preset.key} htmlFor={inputId} className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                id={inputId}
                checked={checked}
                onCheckedChange={(next) => {
                  if (next !== checked) onToggle(preset.key);
                }}
                aria-label={`「${fieldLabel}」的${groupLabel} ${preset.label}`}
              />
              <span>{preset.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 自定义参数块（新增与修改共用同一套字段）
// ---------------------------------------------------------------------------

const CUSTOM_TYPE_OPTIONS: { value: CustomParameterField['value_type']; label: string }[] = [
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '开关' },
  { value: 'enum', label: '下拉选择' },
];

function CustomParameterBlock({
  entry,
  issues,
  idScope,
  onEntryChange,
  action,
}: {
  entry: CustomParameterField;
  issues: string[];
  /** DOM id 前缀：同一弹层里可能同时有多个参数块，控件 id 不能撞 */
  idScope: string;
  onEntryChange: (next: CustomParameterField) => void;
  action: ReactNode;
}) {
  const changeType = (next: CustomParameterField['value_type']): void => {
    const current = entry.default_value;
    const keepDefault =
      (next === 'number' && typeof current === 'number') ||
      (next === 'boolean' && typeof current === 'boolean') ||
      (next === 'string' && typeof current === 'string') ||
      (next === 'enum' &&
        current !== undefined &&
        (entry.enum_options ?? []).some((option) => sameValue(option, current)));
    const updated: CustomParameterField = { ...entry, value_type: next };
    // 换类型后装不下的默认值跟着换掉：留着必然类型不符
    if (!keepDefault) delete updated.default_value;
    // 可选值只在下拉选择里有意义
    if (next !== 'enum') delete updated.enum_options;
    onEntryChange(updated);
  };
  const setDefault = (next: ParameterOverridesValue | undefined): void => {
    const updated: CustomParameterField = { ...entry };
    if (next === undefined) delete updated.default_value;
    else updated.default_value = next;
    onEntryChange(updated);
  };
  const setEnumOptions = (next: ParameterOverridesValue[]): void => {
    const currentDefault = entry.default_value;
    const dropDefault = currentDefault !== undefined && !next.some((option) => sameValue(option, currentDefault));
    const updated: CustomParameterField = { ...entry, enum_options: next };
    // 可选值被删掉后容不下的默认值一并摘掉，否则必然被拒
    if (dropDefault) delete updated.default_value;
    onEntryChange(updated);
  };
  const options = entry.enum_options ?? [];
  const displayName = entry.label.trim() === '' ? '新参数' : entry.label;

  // 同上：边框退场（§9.1），表面阶梯承担行承载可见性
  return (
    <div className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{displayName}</span>
        {action}
      </div>
      <div className="flex items-center gap-2">
        <MiniLabel text="显示名" />
        <Input
          aria-label={`「${displayName}」的显示名`}
          className="h-7 flex-1 text-xs"
          value={entry.label}
          autoComplete="off"
          onChange={(event) => onEntryChange({ ...entry, label: event.target.value })}
        />
      </div>
      <div className="flex items-center gap-2">
        <MiniLabel text="发送名称" />
        <CommitInput
          value={entry.wire_name}
          placeholder="如 style_strength"
          ariaLabel={`「${displayName}」的发送名称`}
          onCommit={(raw) => {
            if (raw !== '') onEntryChange({ ...entry, wire_name: raw });
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <MiniLabel text="类型" />
        <Select value={entry.value_type} onValueChange={(next) => changeType(parseType(next))}>
          <SelectTrigger size="sm" className="w-32" aria-label={`「${displayName}」的类型`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUSTOM_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label htmlFor={`custom-param-${idScope}-required`} className="ml-auto flex cursor-pointer items-center gap-2 text-xs">
          <Switch
            id={`custom-param-${idScope}-required`}
            checked={entry.required}
            onCheckedChange={(next) => onEntryChange({ ...entry, required: next })}
            aria-label={`参数「${displayName}」必填`}
          />
          <span>必填</span>
        </label>
      </div>
      {entry.value_type === 'enum' ? (
        <div className="flex items-start gap-2">
          <MiniLabel text="可选值" />
          <div className="min-w-0 flex-1">
            <OptionListEditor
              options={options}
              onChange={setEnumOptions}
              addInputAriaLabel={`「${displayName}」的新可选值`}
              addButtonAriaLabel={`为「${displayName}」添加可选值`}
              removeButtonAriaPrefix={`删掉「${displayName}」的可选值`}
            />
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <MiniLabel text="默认值" />
        {entry.value_type === 'enum' ? (
          <EnumDefaultSelect
            options={options}
            value={entry.default_value}
            ariaLabel={`「${displayName}」的默认值`}
            noDefaultLabel="保持默认"
            onChange={setDefault}
          />
        ) : entry.value_type === 'number' ? (
          <NumberValueInput
            value={typeof entry.default_value === 'number' ? entry.default_value : undefined}
            ariaLabel={`「${displayName}」的默认值`}
            onCommit={setDefault}
          />
        ) : entry.value_type === 'boolean' ? (
          <Select
            value={entry.default_value === true ? valueKey(true) : entry.default_value === false ? valueKey(false) : NO_DEFAULT_OPTION}
            onValueChange={(next) => setDefault(next === NO_DEFAULT_OPTION ? undefined : next === valueKey(true))}
          >
            <SelectTrigger size="sm" className="w-32" aria-label={`「${displayName}」的默认值`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEFAULT_OPTION}>保持默认</SelectItem>
              <SelectItem value={valueKey(true)}>开</SelectItem>
              <SelectItem value={valueKey(false)}>关</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            aria-label={`「${displayName}」的默认值`}
            className="h-7 flex-1 text-xs"
            value={typeof entry.default_value === 'string' ? entry.default_value : ''}
            autoComplete="off"
            onChange={(event) => setDefault(event.target.value === '' ? undefined : event.target.value)}
          />
        )}
      </div>
      <IssueLine messages={issues} />
    </div>
  );
}

const parseType = (raw: string): CustomParameterField['value_type'] => {
  const hit = CUSTOM_TYPE_OPTIONS.find((option) => option.value === raw);
  return hit?.value ?? 'string';
};

// ---------------------------------------------------------------------------
// 编辑器本体
// ---------------------------------------------------------------------------

export function ParameterOverridesEditor({
  descriptor,
  value,
  onChange,
  liveMediaSlotIds,
}: {
  descriptor: FamilyTemplateParameterDescriptor;
  /** 当前覆盖值（受控）：来自声明或本编辑器上一次的产出 */
  value: ParameterOverrides;
  onChange: (next: ParameterOverrides) => void;
  /** 当前已勾选的素材位：未勾选位的行不渲染（描述符是族级事实，勾选归记录/表单） */
  liveMediaSlotIds: readonly GenerationMediaSlotId[];
}) {
  const fields = useMemo(
    () => visibleOfficialFields(descriptor, liveMediaSlotIds),
    [descriptor, liveMediaSlotIds],
  );
  const issuesByTarget = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of collectOverrideIssues(descriptor, value, liveMediaSlotIds)) {
      const messages = map.get(issue.target) ?? [];
      messages.push(issue.message);
      map.set(issue.target, messages);
    }
    return map;
  }, [descriptor, value, liveMediaSlotIds]);

  const officialByFieldKey = useMemo(
    () => new Map(value.official.map((entry) => [entry.field_key, entry])),
    [value.official],
  );

  const customCount = value.custom.length;
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<CustomParameterField>(() => ({
    label: '',
    wire_name: '',
    value_type: 'string',
    required: false,
  }));
  const [addAttempted, setAddAttempted] = useState(false);
  /** 提交与查重都按去首尾空格后的草稿算；界面里保留原样输入 */
  const normalizedAddDraft: CustomParameterField = useMemo(
    () => ({
      ...addDraft,
      label: addDraft.label.trim(),
      wire_name: addDraft.wire_name.trim(),
    }),
    [addDraft],
  );

  // 新参数的占用表：自定义参数固定发到请求体，因此只算请求体命名空间
  // （保留键 + 请求体官方参数的生效发送名称 + 已有自定义参数；草稿自己还没占名）。
  const takenNamesForAdd = useMemo(() => {
    const names = new Set<string>(descriptor.reserved_wire_names.body);
    for (const field of fields) {
      if (field.wire_location !== 'body') continue;
      const override = officialByFieldKey.get(field.field_key);
      if (override?.enabled === false) continue;
      names.add(effectiveOfficialWireName(field, override));
    }
    for (const entry of value.custom) names.add(entry.wire_name);
    return names;
  }, [descriptor, fields, officialByFieldKey, value.custom]);

  const addIssues = useMemo(
    () => (addAttempted ? customFieldIssues(normalizedAddDraft, (name) => takenNamesForAdd.has(name)) : []),
    [addAttempted, normalizedAddDraft, takenNamesForAdd],
  );

  const submitAdd = (): void => {
    setAddAttempted(true);
    if (customFieldIssues(normalizedAddDraft, (name) => takenNamesForAdd.has(name)).length > 0) return;
    onChange({ ...value, custom: [...value.custom, normalizedAddDraft] });
    setAddDraft({ label: '', wire_name: '', value_type: 'string', required: false });
    setAddAttempted(false);
    setAdding(false);
  };

  const updateCustomAt = (index: number, next: CustomParameterField): void => {
    onChange({
      ...value,
      custom: value.custom.map((entry, i) => (i === index ? next : entry)),
    });
  };
  const removeCustomAt = (index: number): void => {
    onChange({ ...value, custom: value.custom.filter((_, i) => i !== index) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">官方参数</span>
        <InfoHint text={OFFICIAL_SECTION_HINT} subject="官方参数" />
      </div>
      {fields.map((field) => {
        const shared = {
          field,
          override: officialByFieldKey.get(field.field_key),
          issues: issuesByTarget.get(field.field_key) ?? [],
          onChange: (mutate: (entry: OfficialParameterOverride) => OfficialParameterOverride) =>
            onChange(applyOfficialChange(value, field.field_key, mutate)),
        };
        // 素材位行按位标识识别（不按组件名硬判）：可编辑维度与普通参数不同
        return field.media_slot_id !== undefined ? (
          <MediaSlotParameterRow key={field.field_key} {...shared} />
        ) : (
          <OfficialParameterRow key={field.field_key} {...shared} />
        );
      })}

      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">自定义参数</span>
        <span className="text-2xs text-muted-foreground">
          {customCount}/{CUSTOM_LIMIT}
        </span>
      </div>
      {value.custom.map((entry, index) => (
        <CustomParameterBlock
          key={index}
          entry={entry}
          issues={issuesByTarget.get(`custom:${index}`) ?? []}
          idScope={String(index)}
          onEntryChange={(next) => updateCustomAt(index, next)}
          action={
            <Button
              type="button"
              variant="ghost-destructive"
              size="2xs"
              aria-label={`删除参数「${entry.label.trim() === '' ? '新参数' : entry.label}」`}
              onClick={() => removeCustomAt(index)}
            >
              删除
            </Button>
          }
        />
      ))}
      {adding ? (
        <CustomParameterBlock
          entry={addDraft}
          issues={addIssues}
          idScope="add"
          onEntryChange={setAddDraft}
          action={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="2xs"
                aria-label="添加这个自定义参数"
                onClick={submitAdd}
              >
                添加
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="2xs"
                aria-label="取消添加自定义参数"
                onClick={() => {
                  setAddDraft({ label: '', wire_name: '', value_type: 'string', required: false });
                  setAddAttempted(false);
                  setAdding(false);
                }}
              >
                取消
              </Button>
            </div>
          }
        />
      ) : customCount < CUSTOM_LIMIT ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          aria-label="添加自定义参数"
          onClick={() => setAdding(true)}
        >
          添加参数
        </Button>
      ) : (
        <p className="text-2xs text-muted-foreground">{CUSTOM_LIMIT_HINT}</p>
      )}
    </div>
  );
}
