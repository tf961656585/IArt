import type {
  CustomInterfaceFormatDraft,
  CustomInterfaceFormatFormArrayStyle,
  CustomInterfaceFormatFormFieldStyle,
  CustomInterfaceFormatMediaSlotDraft,
  CustomInterfaceFormatNameValue,
  CustomInterfaceFormatParameterDraft,
  CustomInterfaceFormatPayloadFormat,
  CustomInterfaceFormatValueBinding,
  InterfaceFormatJsonValue,
  InterfaceFormatModelBinding,
  InterfaceFormatPromptBinding,
  RecipeCondition,
  RecipeResultForm,
} from '@iart/contracts';
import type { MediaSlotRow } from './InterfaceFormatMediaSlotFields';
import { defaultMediaCarrier } from './InterfaceFormatMediaSlotFields';
import { parseDefaultValue } from './parameterDefaults';
import {
  buildConditionFromRows,
  type RecipeConditionRowDraft,
} from '../provider-connection/interfaceRecipeConditions';

/**
 * 接口格式编辑器的草稿构建（唯一来源）。
 *
 * 提交与保存前校验共用这里：只有一份「界面行 → 声明式草稿」的映射，校验拿到的就是
 * 真正会发出去的请求体。半填行不在这里丢弃——只跳过完全空白的行，让契约去判必填，
 * 界面再按契约报出的字段位置定位回具体行。
 *
 * 请求落点（2026-10-27 批次）：参数发到请求体 / 查询参数 / 请求头，提示词另可落到纯文本正文，
 * 模型 ID 另可落到地址路径。落点与名称/路径的合法性判据唯一实现在 contracts
 * （`interface-format-binding.ts`），本文件只做「界面行 → 契约形状」的搬运。
 */

/** 参数可选的发送落点（与 `InterfaceFormatValueBindingSchema` 的 location 同词表）。 */
export type WireLocation = 'body' | 'query' | 'header';

/**
 * 提示词落点：请求体 / 查询参数 / 纯文本正文。
 *
 * 提示词不能发到请求头（契约的 `InterfaceFormatPromptBindingSchema` 也不含 header）：
 * 请求头是单行的键值对，放不下一段提示词。
 */
export type PromptLocation = 'body' | 'query' | 'text';

/**
 * 模型 ID 落点：请求体 / 查询参数 / 地址路径占位 / 不发送。
 *
 * 模型 ID 同样不发到请求头（契约不含 header 分支）。
 */
export type ModelLocation = 'body' | 'query' | 'path' | 'none';

export type PayloadFormat = CustomInterfaceFormatPayloadFormat;
export type FormFieldStyle = CustomInterfaceFormatFormFieldStyle;
export type FormArrayStyle = CustomInterfaceFormatFormArrayStyle;

/** 固定请求头 / 固定查询参数的一行草稿。 */
export type NameValueRow = {
  name: string;
  value: string;
};

export type ParamRow = {
  /** 这个参数发到哪里（请求体 / 查询参数 / 请求头）。 */
  location: WireLocation;
  /** 请求体路径 / 查询参数名 / 请求头名；含义随 `location` 变化。 */
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  defaultValue: string;
  enumValues: string[];
  /** 最近一次自动清空默认值的弱提示；用户再改值时清掉（不进请求体）。 */
  defaultNote: string;
  /** 换发送位置后的弱提示（旧值已清空）；用户再改键时清掉（不进请求体）。 */
  locationNote: string;
};

export type EditorState = {
  displayName: string;
  submitPath: string;
  method: 'POST' | 'GET' | 'PUT' | 'PATCH';
  payloadFormat: PayloadFormat;
  contentType: string;
  formFieldStyle: FormFieldStyle;
  formArrayStyle: FormArrayStyle;
  authKind: 'bearer' | 'header_api_key' | 'query_api_key';
  authHeaderName: string;
  authPrefix: string;
  authQueryName: string;
  fixedHeaders: NameValueRow[];
  fixedQuery: NameValueRow[];
  promptLocation: PromptLocation;
  promptKey: string;
  modelLocation: ModelLocation;
  modelKey: string;
  params: ParamRow[];
  mediaSlots: MediaSlotRow[];
  taskMode: 'sync' | 'async';
  identityPath: string;
  pollingPath: string;
  pollingMethod: 'GET' | 'POST';
  pollingHeaders: NameValueRow[];
  pollingQuery: NameValueRow[];
  /** 轮询请求体的 JSON 文本（字符串值里可以写 `{id}` 等占位）。 */
  pollingBody: string;
  pollingBodyFormat: 'json' | 'form';
  pollingContentType: string;
  statusPath: string;
  /** 轮询成功的状态取值列表（值列表控件直接持有数组）。 */
  successValues: string[];
  /** 轮询失败的状态取值列表；可留空。 */
  failureValues: string[];
  intervalMs: string;
  maxAttempts: string;
  resultKind: 'direct_url' | 'inline_media' | 'needs_fetch';
  resultPathsText: string;
  mediaType: 'image' | 'video' | 'audio';
  encoding: 'data_url' | 'json_inline' | 'raw_base64';
  fetchIdentityPath: string;
  contentUrlTemplate: string;
  requiresAuth: boolean;
  failureRows: RecipeConditionRowDraft[];
  failureReason: string;
};

export type InterfaceFormatDraftBuild = {
  draft: CustomInterfaceFormatDraft;
  /** `draft.parameters[i]` 对应的界面行号（契约错误据此定位回具体行）。 */
  parameterRowIndexes: number[];
  /** `draft.media_slots[i]` 对应的界面行号。 */
  mediaRowIndexes: number[];
  /** `draft.submit.headers[i]` 对应的界面行号。 */
  fixedHeaderRowIndexes: number[];
  /** `draft.submit.query[i]` 对应的界面行号。 */
  fixedQueryRowIndexes: number[];
  /** `draft.behavior.async.polling.headers[i]` 对应的界面行号。 */
  pollingHeaderRowIndexes: number[];
  /** `draft.behavior.async.polling.query[i]` 对应的界面行号。 */
  pollingQueryRowIndexes: number[];
};

const splitPaths = (raw: string): string[] =>
  raw
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** 值列表控件已 trim / 去重；这里只兜一层空白项，保证草稿里没有空串。 */
const cleanValues = (values: readonly string[]): string[] =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);

/**
 * 从配方条件取「状态取值」列表：只有 `eq` / `in` 表达值集合，
 * 组合条件（all / any / not）没有可映射的单个取值列表。
 */
export const conditionValues = (condition: RecipeCondition | undefined): string[] => {
  if (condition === undefined) return [];
  if (condition.op === 'all' || condition.op === 'any' || condition.op === 'not') return [];
  if (condition.op !== 'eq' && condition.op !== 'in') return [];
  const value = condition.value;
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item));
};

/** 完全空白 = 用户还没开始填这一行；只要有一处内容就当作填写中，参与校验。 */
export const isBlankParameterRow = (row: ParamRow): boolean =>
  row.location === 'body'
  && row.key.trim() === ''
  && row.label.trim() === ''
  && row.defaultValue.trim() === ''
  && row.enumValues.every((value) => value.trim() === '')
  && row.type === 'string'
  && !row.required;

/** 固定请求头 / 固定查询参数：名称与取值都空才算空白行。 */
export const isBlankNameValueRow = (row: NameValueRow): boolean =>
  row.name.trim() === '' && row.value.trim() === '';

/**
 * 完全空白 = 用户还没开始填这一行。
 * 除字段位置与名称外，位标识 / 必填 / 张数 / 上传方式也必须仍是新建时的默认值——
 * 只改过其中任何一项（例如只把上传方式从默认改成别的）都算填写中，必须参与校验。
 */
export const isBlankMediaSlotRow = (
  row: MediaSlotRow,
  payloadFormat: PayloadFormat,
): boolean =>
  row.fieldKey.trim() === ''
  && row.label.trim() === ''
  && row.slotId === 'reference_image'
  && !row.required
  && row.maxFiles === '1'
  && row.carrier === defaultMediaCarrier(payloadFormat);

/**
 * 轮询请求体的 JSON 文本 → 契约值。
 *
 * 空文本 = 不带请求体（`undefined`）。解析失败是界面才知道的输入错误（契约只收 JSON 值），
 * 由 `collectIssues` 拦住保存；这里返回失败原因，不静默丢成空请求体。
 */
export const parsePollingBody = (
  raw: string,
): { ok: true; value: InterfaceFormatJsonValue | undefined } | { ok: false; message: string } => {
  const text = raw.trim();
  if (text === '') return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: '轮询请求体不是有效的 JSON，检查引号和括号后再试' };
  }
  return { ok: true, value: parsed as InterfaceFormatJsonValue };
};

/** 界面落点 → 契约 binding（参数 / 提示词 / 模型 ID 共用同一份形状）。 */
export const bindingFor = (location: WireLocation, key: string): CustomInterfaceFormatValueBinding => {
  const trimmed = key.trim();
  if (location === 'body') return { location: 'body', path: trimmed };
  if (location === 'query') return { location: 'query', name: trimmed };
  return { location: 'header', name: trimmed };
};

const promptBindingOf = (state: EditorState): InterfaceFormatPromptBinding => {
  if (state.promptLocation === 'text') return { location: 'text' };
  const key = state.promptKey.trim();
  return state.promptLocation === 'body'
    ? { location: 'body', path: key }
    : { location: 'query', name: key };
};

const modelBindingOf = (state: EditorState): InterfaceFormatModelBinding | undefined => {
  if (state.modelLocation === 'none') return undefined;
  if (state.modelLocation === 'path') return { location: 'path' };
  const key = state.modelKey.trim();
  return state.modelLocation === 'body'
    ? { location: 'body', path: key }
    : { location: 'query', name: key };
};

/** 固定头 / 固定查询参数行 → 名称值列表（顺带记录草稿下标到界面行号的映射）。 */
const buildNameValueList = (
  rows: readonly NameValueRow[],
  rowIndexes: number[],
): CustomInterfaceFormatNameValue[] => {
  const list: CustomInterfaceFormatNameValue[] = [];
  rows.forEach((row, rowIndex) => {
    if (isBlankNameValueRow(row)) return;
    rowIndexes.push(rowIndex);
    list.push({ name: row.name.trim(), value: row.value });
  });
  return list;
};

const buildResult = (state: EditorState): RecipeResultForm => {
  if (state.resultKind === 'needs_fetch') {
    return {
      kind: 'needs_fetch',
      identity_field_path: state.fetchIdentityPath.trim(),
      content_url_template: state.contentUrlTemplate.trim(),
      accept: 'binary',
      media_type: state.mediaType,
    };
  }
  const mediaFieldPaths = splitPaths(state.resultPathsText);
  if (state.resultKind === 'inline_media') {
    return {
      kind: 'inline_media',
      media_field_paths: mediaFieldPaths,
      media_type: state.mediaType,
      encoding: state.encoding,
    };
  }
  return {
    kind: 'direct_url',
    media_field_paths: mediaFieldPaths,
    media_type: state.mediaType,
  };
};

export const buildInterfaceFormatDraft = (
  state: EditorState,
  formatId?: string,
): InterfaceFormatDraftBuild => {
  const parameterRowIndexes: number[] = [];
  const parameters: CustomInterfaceFormatParameterDraft[] = [];
  state.params.forEach((row, rowIndex) => {
    if (isBlankParameterRow(row)) return;
    parameterRowIndexes.push(rowIndex);
    const parsedDefault = parseDefaultValue(row.type, row.defaultValue, row.enumValues);
    const enumValues = row.enumValues
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    parameters.push({
      binding: bindingFor(row.location, row.key),
      label: row.label.trim(),
      type: row.type,
      required: row.required,
      ...(parsedDefault.ok && parsedDefault.value !== undefined
        ? { default_value: parsedDefault.value }
        : {}),
      ...(row.type === 'enum' && enumValues.length > 0 ? { enum_values: enumValues } : {}),
    });
  });

  const mediaRowIndexes: number[] = [];
  const mediaSlots: CustomInterfaceFormatMediaSlotDraft[] = [];
  state.mediaSlots.forEach((row, rowIndex) => {
    if (isBlankMediaSlotRow(row, state.payloadFormat)) return;
    mediaRowIndexes.push(rowIndex);
    mediaSlots.push({
      slot_id: row.slotId,
      field_key: row.fieldKey.trim(),
      label: row.label.trim(),
      required: row.required,
      max_files: Number(row.maxFiles) > 0 ? Number(row.maxFiles) : 1,
      // 上传方式为空（预设详情判不出载体）时用 `public_url` 仅作校验占位：
      // 界面 issue 会拦住保存，真正发出去的草稿不会带着用户没选的载体。
      carrier: row.carrier === '' ? 'public_url' : row.carrier,
    });
  });

  const fixedHeaderRowIndexes: number[] = [];
  const fixedQueryRowIndexes: number[] = [];
  const pollingHeaderRowIndexes: number[] = [];
  const pollingQueryRowIndexes: number[] = [];

  const modelBinding = modelBindingOf(state);
  const pollingBody = parsePollingBody(state.pollingBody);
  const failureCondition = buildConditionFromRows(state.failureRows);
  const draft: CustomInterfaceFormatDraft = {
    ...(formatId === undefined || formatId === '' ? {} : { format_id: formatId }),
    display_name: state.displayName.trim(),
    submit: {
      path: state.submitPath.trim(),
      method: state.method,
      payload_format: state.payloadFormat,
      content_type: state.contentType.trim() === '' ? null : state.contentType.trim(),
      auth:
        state.authKind === 'query_api_key'
          ? { kind: 'query_api_key', query_name: state.authQueryName.trim() }
          : {
              kind: state.authKind,
              header_name: state.authHeaderName.trim(),
              ...(state.authKind === 'bearer' && state.authPrefix.trim() !== ''
                ? { prefix: state.authPrefix.trim() }
                : {}),
            },
      headers: buildNameValueList(state.fixedHeaders, fixedHeaderRowIndexes),
      query: buildNameValueList(state.fixedQuery, fixedQueryRowIndexes),
      form_field_style: state.formFieldStyle,
      form_array_style: state.formArrayStyle,
    },
    ...(modelBinding === undefined ? {} : { model_binding: modelBinding }),
    parameters,
    media_slots: mediaSlots,
    prompt_binding: promptBindingOf(state),
    behavior: {
      ...(failureCondition === null ? {} : { failure_when: failureCondition }),
      ...(state.failureReason.trim() === '' ? {} : { failure_reason: state.failureReason.trim() }),
      requires_auth: state.requiresAuth,
      result: buildResult(state),
      ...(state.taskMode === 'sync'
        ? {}
        : {
            async: {
              identity_path: state.identityPath.trim(),
              polling: {
                path: state.pollingPath.trim(),
                method: state.pollingMethod,
                headers: buildNameValueList(state.pollingHeaders, pollingHeaderRowIndexes),
                query: buildNameValueList(state.pollingQuery, pollingQueryRowIndexes),
                // 只有 POST 轮询才有请求体；GET 下不渲染该字段，草稿也不带（切回 POST 时值仍在状态里）。
                ...(state.pollingMethod === 'POST' && pollingBody.ok && pollingBody.value !== undefined
                  ? { body: pollingBody.value }
                  : {}),
                body_format: state.pollingBodyFormat,
                content_type:
                  state.pollingContentType.trim() === '' ? null : state.pollingContentType.trim(),
                status_path: state.statusPath.trim(),
                success_values: cleanValues(state.successValues),
                failure_values: cleanValues(state.failureValues),
                interval_ms: Number(state.intervalMs) > 0 ? Number(state.intervalMs) : 10000,
                max_attempts: Number(state.maxAttempts) > 0 ? Number(state.maxAttempts) : 300,
              },
            },
          }),
    },
  };

  return {
    draft,
    parameterRowIndexes,
    mediaRowIndexes,
    fixedHeaderRowIndexes,
    fixedQueryRowIndexes,
    pollingHeaderRowIndexes,
    pollingQueryRowIndexes,
  };
};
