import {
  CustomInterfaceFormatDraftSchema,
  RecipeDirectUrlResultSchema,
  RecipeInlineMediaResultSchema,
  RecipeNeedsFetchResultSchema,
  interfaceFormatBodyPathsOverlap,
} from '@iart/contracts';
import type { CustomInterfaceFormatDraft } from '@iart/contracts';
import {
  buildInterfaceFormatDraft,
  isBlankMediaSlotRow,
  parsePollingBody,
  type EditorState,
  type InterfaceFormatDraftBuild,
  type WireLocation,
} from './interfaceFormatDraft';
import { parseDefaultValue } from './parameterDefaults';

/**
 * 接口格式编辑器的校验收口。
 *
 * 契约能表达的（必填、路径/名称格式、重复键、命名空间冲突、素材位与提交体一致性）一律交给
 * `CustomInterfaceFormatDraftSchema`，这里只把它的 `issue.path` 翻译成「哪个分节的哪个控件」，
 * 并补两类契约表达不了、只有界面知道的检查：半填行（已排除完全空白行后由契约兜住）之外，
 * 只有「默认值原文能否换成该类型的值」与「轮询请求体的 JSON 文本能否解析」。
 *
 * 落点（请求体 / 查询参数 / 请求头）由契约判定，界面只负责把同一个错误指回具体行与具体控件；
 * 前端不复制第二份命名空间冲突判定，也不过滤后端能报的错误。
 */

export const SECTION_BASIC = 'interface-format-section-basic';
export const SECTION_SUBMIT = 'interface-format-section-submit';
export const SECTION_PARAMS = 'interface-format-section-params';
export const SECTION_MEDIA = 'interface-format-section-media';
export const SECTION_TASK = 'interface-format-section-task';
export const SECTION_RESULT = 'interface-format-section-result';

export type EditorIssue = {
  /** 去重键 */
  id: string;
  /** 顶部汇总短标签，如「第 1 行参数：名称」 */
  label: string;
  /** 行内错误文案 */
  message: string;
  /** 对应分节 id，用于滚动 */
  sectionId: string;
  /** 聚焦目标元素的 id（该字段的控件） */
  fieldId: string;
  rowIndex?: number;
};

/** 契约错误的结构脸：兼容 zod 的 issue，又不把 zod 类型引进界面层。 */
type SchemaIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code: string;
};

type IssueTarget = {
  fieldId: string;
  sectionId: string;
  label: string;
  rowIndex?: number;
};

const fixedTarget = (fieldId: string, sectionId: string, label: string): IssueTarget => ({
  fieldId,
  sectionId,
  label,
});

const rowLabel = (kind: string, rowIndex: number, field: string): string =>
  `第 ${rowIndex + 1} 行${kind}：${field}`;

/** 参数键在不同落点下的界面名称（同一份错误按落点说人话）。 */
const parameterKeyLabel = (location: WireLocation): string => {
  if (location === 'query') return '查询参数名';
  if (location === 'header') return '请求头名';
  return '请求体路径';
};

const parameterKeyPlaceholder = (location: WireLocation): string => {
  if (location === 'header') return '例如 X-Quality';
  return '例如 size';
};

/** 已知业务码给用户能看懂的具体原因；英文 zod 默认文案一律不直出。 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  interface_format_body_path_invalid: '只能用字母、数字、_、-，层级之间用点号分隔（例如 input.text）',
  interface_format_submit_path_not_relative: '提交路径要是相对路径：以 / 开头，不能带域名或 ..',
  interface_format_polling_path_not_relative: '查任务状态的地址要是相对路径：以 / 开头，不能带域名或 ..',
  interface_format_parameter_key_duplicated: '这个发送位置和另一行重复或重叠了',
  interface_format_parameter_enum_values_missing: '选项类型至少要给一个可选值',
  interface_format_field_key_reserved: '这个请求体路径是系统保留的，提示词请用「提示词发送到」填写',
  interface_format_prompt_path_conflicts_with_parameter: '提示词的位置不能和参数的发送位置重叠',
  interface_format_model_path_conflicts: '模型 ID 的发送位置不能和提示词或参数重复',
  interface_format_media_field_key_conflicts: '素材位的字段位置不能和参数、提示词或模型 ID 重叠',
  interface_format_media_slot_duplicated: '同一个素材位只能出现一次',
  interface_format_multipart_slot_requires_multipart_submit: '这个素材位要用表单上传，请把请求体改成「表单上传」',
  interface_format_multipart_slot_requires_null_content_type: '表单文件上传时 Content-Type 要留空',
  interface_format_inline_slot_single_file_only: '内嵌内容一次只能传一个文件',
  interface_format_needs_fetch_requires_async: '再取一次要先在任务模式里选「先返回任务，稍后再取」',
  // 固定请求头 / 固定查询参数
  interface_format_header_name_forbidden: '这个请求头会在发送时自动写入，不能在这里固定；换一个请求头名',
  interface_format_header_name_invalid: '请求头名只能用字母、数字和 - _ 等符号，不能有空格或冒号',
  interface_format_query_name_invalid: '查询参数名只能用字母、数字和 _ . - [ ]，不能有空格、&、= 或 ?',
  interface_format_header_value_invalid: '请求头的取值不能含换行或控制字符',
  interface_format_query_value_invalid: '查询参数的取值不能含换行或控制字符',
  interface_format_fixed_header_duplicated: '同一个请求头只能出现一次',
  interface_format_fixed_query_duplicated: '同一个查询参数只能出现一次',
  interface_format_fixed_header_conflicts: '这个固定请求头和鉴权头或某个参数发了同一个请求头，请改一个',
  interface_format_fixed_query_conflicts: '这个固定查询参数和鉴权或某个参数用了同一个名字，请改一个',
  interface_format_submit_path_query_conflicts: '提交路径里已经写死的查询参数不要再声明一次',
  interface_format_polling_path_query_conflicts: '查询地址里已经写死的查询参数不要再声明一次',
  // 请求体形态与落点的组合约束
  interface_format_form_content_type_invalid: '网址编码表单的 Content-Type 要是 application/x-www-form-urlencoded',
  interface_format_polling_body_requires_post: '只有 POST 查询才能带请求体，请把查询方法改成 POST，或清空请求体',
  interface_format_polling_form_body_must_be_object: '表单形式的查询请求体要是 JSON 对象，例如 {"task_id": "{id}"}',
  interface_format_text_payload_requires_text_prompt: '请求体是纯文本时，提示词的发送位置要选「纯文本正文」',
  interface_format_text_payload_forbids_media_slots: '纯文本请求体不能带素材位，请把素材位删掉或换一种请求体',
  interface_format_text_payload_forbids_body_fields: '纯文本请求体里没有字段，这个值请改发到查询参数或请求头',
  interface_format_text_binding_requires_text_payload: '提示词选了纯文本正文时，请求体形态要改成「纯文本」',
  interface_format_model_path_binding_requires_placeholder: '模型 ID 要放进地址时，提交路径里必须写 {model}',
};

const PROMPT_CONFLICT_CODE = 'interface_format_prompt_path_conflicts_with_parameter';
const NEEDS_FETCH_ASYNC_CODE = 'interface_format_needs_fetch_requires_async';

const PARAMETER_FIELD_SUFFIXES: Readonly<Record<string, string>> = {
  key: 'key',
  label: 'label',
  type: 'type',
  default_value: 'default',
  enum_values: 'enum-values',
  required: 'required',
};

const MEDIA_FIELDS: Readonly<Record<string, { suffix: string; label: string }>> = {
  slot_id: { suffix: 'slot', label: '位' },
  field_key: { suffix: 'field', label: '字段位置' },
  label: { suffix: 'label', label: '名称' },
  max_files: { suffix: 'max', label: '最多几张' },
  carrier: { suffix: 'carrier', label: '上传方式' },
};

const MEDIA_SLOT_FIELD = { suffix: 'slot', label: '位' };

/** 固定请求头 / 固定查询参数行（提交段与轮询段共用同一套定位规则）。 */
const wireRowTarget = (
  kind: 'header' | 'query',
  scope: 'submit' | 'polling',
  draftIndex: number | undefined,
  leaf: string | undefined,
  build: InterfaceFormatDraftBuild,
): IssueTarget => {
  const rowIndexes = scope === 'submit'
    ? (kind === 'header' ? build.fixedHeaderRowIndexes : build.fixedQueryRowIndexes)
    : (kind === 'header' ? build.pollingHeaderRowIndexes : build.pollingQueryRowIndexes);
  const sectionId = scope === 'submit' ? SECTION_SUBMIT : SECTION_TASK;
  const rowName = kind === 'header' ? '请求头' : '查询参数';
  const kindLabel = scope === 'submit' ? `固定${rowName}` : `轮询${rowName}`;
  const prefix = scope === 'submit' ? 'interface-format-fixed' : 'interface-format-polling';
  const rowIndex = draftIndex === undefined ? undefined : rowIndexes[draftIndex];
  if (rowIndex === undefined) {
    return fixedTarget(
      scope === 'submit' ? 'interface-format-fixed-headers' : 'interface-format-polling-request',
      sectionId,
      kindLabel,
    );
  }
  const field = leaf === 'value' ? 'value' : 'name';
  return {
    fieldId: `${prefix}-${kind}-${rowIndex}-${field}`,
    sectionId,
    label: rowLabel(kindLabel, rowIndex, field === 'name' ? '名称' : '取值'),
    rowIndex,
  };
};

const targetForPath = (
  path: readonly (string | number)[],
  build: InterfaceFormatDraftBuild,
  state: EditorState,
): IssueTarget => {
  const head = path[0];
  const second = path[1];
  const third = path[2];
  const fourth = path[3];

  if (head === 'display_name' || head === 'format_id') {
    return fixedTarget('interface-format-name', SECTION_BASIC, '名称');
  }

  if (head === 'submit') {
    if (second === 'method') return fixedTarget('interface-format-method', SECTION_SUBMIT, '请求方法');
    if (second === 'payload_format') return fixedTarget('interface-format-payload-format', SECTION_SUBMIT, '请求体');
    if (second === 'content_type') return fixedTarget('interface-format-content-type', SECTION_SUBMIT, 'Content-Type');
    if (second === 'form_field_style') {
      return fixedTarget('interface-format-form-field-style', SECTION_SUBMIT, '嵌套字段写法');
    }
    if (second === 'form_array_style') {
      return fixedTarget('interface-format-form-array-style', SECTION_SUBMIT, '数组写法');
    }
    if (second === 'headers') {
      return wireRowTarget('header', 'submit', typeof third === 'number' ? third : undefined, typeof fourth === 'string' ? fourth : undefined, build);
    }
    if (second === 'query') {
      return wireRowTarget('query', 'submit', typeof third === 'number' ? third : undefined, typeof fourth === 'string' ? fourth : undefined, build);
    }
    if (second === 'auth') {
      if (third === 'kind') return fixedTarget('interface-format-auth-kind', SECTION_SUBMIT, '鉴权方式');
      if (third === 'query_name') {
        return fixedTarget('interface-format-auth-query-name', SECTION_SUBMIT, '鉴权查询参数名');
      }
      if (third === 'prefix') return fixedTarget('interface-format-auth-prefix', SECTION_SUBMIT, '令牌前缀');
      return fixedTarget('interface-format-auth-header', SECTION_SUBMIT, '鉴权头名');
    }
    return fixedTarget('interface-format-submit-path', SECTION_SUBMIT, '提交路径');
  }

  if (head === 'model_binding') {
    const label = state.modelLocation === 'query' ? '模型 ID 查询参数名' : '模型 ID 位置';
    return fixedTarget('interface-format-model-key', SECTION_SUBMIT, label);
  }

  if (head === 'prompt_binding') {
    const label = state.promptLocation === 'query' ? '提示词查询参数名' : '提示词位置';
    return fixedTarget('interface-format-prompt-key', SECTION_PARAMS, label);
  }

  if (head === 'parameters') {
    const draftIndex = typeof second === 'number' ? second : -1;
    const rowIndex = draftIndex >= 0 ? build.parameterRowIndexes[draftIndex] : undefined;
    if (rowIndex === undefined) {
      return fixedTarget('interface-format-prompt-key', SECTION_PARAMS, '参数');
    }
    const leaf = typeof third === 'string' ? third : 'key';
    const location = state.params[rowIndex]?.location ?? 'body';
    if (leaf === 'binding') {
      return {
        fieldId: `interface-format-param-${rowIndex}-key`,
        sectionId: SECTION_PARAMS,
        label: rowLabel('参数', rowIndex, parameterKeyLabel(location)),
        rowIndex,
      };
    }
    const suffix = PARAMETER_FIELD_SUFFIXES[leaf] ?? 'key';
    const label = leaf === 'label'
      ? '名称'
      : leaf === 'type'
        ? '类型'
        : leaf === 'default_value'
          ? '默认值'
          : leaf === 'enum_values'
            ? '可选值'
            : leaf === 'required'
              ? '必填'
              : parameterKeyLabel(location);
    return {
      fieldId: `interface-format-param-${rowIndex}-${suffix}`,
      sectionId: SECTION_PARAMS,
      label: rowLabel('参数', rowIndex, label),
      rowIndex,
    };
  }

  if (head === 'media_slots') {
    const draftIndex = typeof second === 'number' ? second : -1;
    const rowIndex = draftIndex >= 0 ? build.mediaRowIndexes[draftIndex] : undefined;
    if (rowIndex === undefined) {
      return fixedTarget(SECTION_MEDIA, SECTION_MEDIA, '素材位');
    }
    const leaf = typeof third === 'string' ? third : 'slot_id';
    const field = MEDIA_FIELDS[leaf] ?? MEDIA_SLOT_FIELD;
    return {
      fieldId: `interface-format-media-${rowIndex}-${field.suffix}`,
      sectionId: SECTION_MEDIA,
      label: rowLabel('素材位', rowIndex, field.label),
      rowIndex,
    };
  }

  if (head === 'behavior') {
    if (second === 'failure_reason') {
      return fixedTarget('interface-format-failure-reason', SECTION_RESULT, '失败原因');
    }
    if (second === 'async') {
      if (third === 'identity_path') {
        return fixedTarget('interface-format-identity-path', SECTION_TASK, '任务标识位置');
      }
      if (third === 'polling') {
        const leaf = path[3];
        if (leaf === 'method') return fixedTarget('interface-format-polling-method', SECTION_TASK, '轮询方法');
        if (leaf === 'status_path') return fixedTarget('interface-format-status-path', SECTION_TASK, '状态字段');
        if (leaf === 'success_values') return fixedTarget('interface-format-success-values', SECTION_TASK, '成功值');
        if (leaf === 'failure_values') return fixedTarget('interface-format-failure-values', SECTION_TASK, '失败值');
        if (leaf === 'interval_ms') return fixedTarget('interface-format-interval', SECTION_TASK, '轮询间隔');
        if (leaf === 'max_attempts') return fixedTarget('interface-format-max-attempts', SECTION_TASK, '最多查询次数');
        if (leaf === 'headers') {
          return wireRowTarget('header', 'polling', typeof path[4] === 'number' ? path[4] : undefined, typeof path[5] === 'string' ? path[5] : undefined, build);
        }
        if (leaf === 'query') {
          return wireRowTarget('query', 'polling', typeof path[4] === 'number' ? path[4] : undefined, typeof path[5] === 'string' ? path[5] : undefined, build);
        }
        if (leaf === 'body') return fixedTarget('interface-format-polling-body', SECTION_TASK, '轮询请求体');
        if (leaf === 'body_format') {
          return fixedTarget('interface-format-polling-body-format', SECTION_TASK, '轮询请求体形态');
        }
        if (leaf === 'content_type') {
          return fixedTarget('interface-format-polling-content-type', SECTION_TASK, '轮询 Content-Type');
        }
        return fixedTarget('interface-format-polling-path', SECTION_TASK, '轮询地址');
      }
      return fixedTarget('interface-format-identity-path', SECTION_TASK, '任务标识位置');
    }
    if (second === 'result') {
      if (third === 'media_type') return fixedTarget('interface-format-media-type', SECTION_RESULT, '媒体类型');
      if (third === 'media_field_paths') return fixedTarget('interface-format-result-paths', SECTION_RESULT, '产物路径');
      if (third === 'encoding') return fixedTarget('interface-format-encoding', SECTION_RESULT, '内容编码');
      if (third === 'accept' || third === 'after' || third === 'identity_field_path') {
        return fixedTarget('interface-format-fetch-identity', SECTION_RESULT, '再取一次的标识路径');
      }
      if (third === 'content_url_template') {
        return fixedTarget('interface-format-content-url', SECTION_RESULT, '内容地址模板');
      }
      return fixedTarget('interface-format-result-kind', SECTION_RESULT, '结果形态');
    }
    return fixedTarget('interface-format-result-kind', SECTION_RESULT, '结果形态');
  }

  return fixedTarget('interface-format-name', SECTION_BASIC, '名称');
};

const pathMessage = (
  path: readonly (string | number)[],
  code: string,
  state: EditorState,
): string => {
  const head = path[0];
  const second = path[1];
  const third = path[2];
  const fourth = path[3];

  /** 参数键的提示：同一个错误按这一行当前的落点说（字段位置 / 查询参数名 / 请求头名）。 */
  const parameterKeyHint = (missing: boolean): string => {
    const rowIndex = typeof second === 'number' ? second : -1;
    const location = state.params[rowIndex]?.location ?? 'body';
    const name = parameterKeyLabel(location);
    return missing ? `${name}要填，${parameterKeyPlaceholder(location)}` : `${name}太长了`;
  };

  if (code === 'too_big') {
    if (head === 'display_name') return '名称最多 80 字';
    if (head === 'submit' && second === 'path') return '提交路径太长了';
    if (head === 'submit' && second === 'content_type') return 'Content-Type 太长了（最多 160 字）';
    if (head === 'submit' && second === 'auth' && third === 'header_name') return '鉴权头名最多 80 字';
    if (head === 'submit' && second === 'auth' && third === 'query_name') return '鉴权查询参数名最多 80 字';
    if (head === 'submit' && second === 'auth' && third === 'prefix') return '令牌前缀最多 40 字';
    if (head === 'submit' && (second === 'headers' || second === 'query')) {
      return fourth === 'value' ? '取值太长了' : '名称太长了（最多 120 字）';
    }
    if (head === 'parameters' && second === undefined) return '参数最多 50 个';
    if (head === 'parameters') {
      if (third === 'enum_values') {
        // 第 4 段说明超长的是数组里的单个取值，不是数组本身。
        return path.length > 3 ? '单个取值最多 160 字' : '可选值最多 50 个';
      }
      if (third === 'binding') return parameterKeyHint(false);
      return '这一行太长了，请精简';
    }
    if (head === 'media_slots' && second === undefined) return '素材位最多 20 个';
    if (head === 'media_slots') {
      if (third === 'field_key') return '字段位置太长了（最多 200 字）';
      if (third === 'label') return '名称最多 80 字';
      if (third === 'max_files') return '最多几张要填 1 到 50';
      return '这一行太长了，请精简';
    }
    if (head === 'prompt_binding') return '提示词位置太长了';
    if (head === 'model_binding') return '模型 ID 位置太长了';
    if (head === 'behavior' && second === 'failure_reason') return '失败原因最多 140 字';
    if (head === 'behavior' && second === 'async' && third === 'polling') {
      const leaf = path[3];
      if (leaf === 'success_values' || leaf === 'failure_values') {
        return path.length > 4 ? '单个取值最多 160 字' : '取值最多 50 个';
      }
      if (leaf === 'headers' || leaf === 'query') {
        return '这一行太长了，请精简';
      }
      if (leaf === 'content_type') return 'Content-Type 太长了（最多 160 字）';
      return '这一项数值超出范围';
    }
    return '这一项数值超出范围';
  }

  if (code === 'too_small') {
    if (head === 'media_slots' && third === 'max_files') return '最多几张至少为 1';
    if (head === 'behavior' && second === 'async' && third === 'polling') {
      const leaf = path[3];
      if (leaf === 'interval_ms') return '轮询间隔不能少于 500 毫秒';
      if (leaf === 'max_attempts') return '最多查询次数至少为 1';
    }
    // 其余最短长度落在文本字段上，沿用下面按字段给的「要填」文案。
  }

  if (head === 'display_name' || head === 'format_id') return '名称要填';
  if (head === 'submit') {
    if (second === 'path') return '提交路径要填，并且是相对路径（以 / 开头）';
    if (second === 'auth' && third === 'header_name') return '鉴权头名要填';
    if (second === 'auth' && third === 'query_name') return '鉴权查询参数名要填，例如 key';
    if (second === 'auth' && third === 'prefix') return '令牌前缀要填';
    if (second === 'headers' || second === 'query') {
      return fourth === 'value' ? '取值没填完整' : '名称要填';
    }
    return '提交请求没填完整';
  }
  if (head === 'model_binding') {
    return state.modelLocation === 'query' ? '模型 ID 查询参数名要填，例如 model' : '模型 ID 位置要填，例如 model';
  }
  if (head === 'prompt_binding') {
    return state.promptLocation === 'query' ? '提示词查询参数名要填，例如 prompt' : '提示词位置要填，例如 prompt';
  }
  if (head === 'parameters') {
    const leaf = typeof third === 'string' ? third : 'key';
    if (leaf === 'binding') return parameterKeyHint(true);
    if (leaf === 'label') return '名称要填';
    if (leaf === 'enum_values') return '至少要给一个可选值';
    if (leaf === 'default_value') return '默认值和类型不匹配';
    return '参数没填完整';
  }
  if (head === 'media_slots') {
    const leaf = typeof third === 'string' ? third : 'field_key';
    if (leaf === 'field_key') return '字段位置要填，例如 image';
    if (leaf === 'label') return '名称要填';
    if (leaf === 'max_files') return '张数要填 1 或更大的整数';
    return '素材位没填完整';
  }
  if (head === 'behavior') {
    if (second === 'failure_reason') return '失败原因最多 140 字';
    if (second === 'async') {
      if (third === 'identity_path') return '任务标识要填';
      if (third === 'polling') {
        const leaf = path[3];
        if (leaf === 'path') return '轮询地址要填，并且是相对路径（以 / 开头）';
        if (leaf === 'status_path') return '状态字段要填';
        if (leaf === 'success_values') return '成功值至少要有一个';
        if (leaf === 'interval_ms') return '轮询间隔要填（500 毫秒以上）';
        if (leaf === 'max_attempts') return '最多查询次数要填';
        if (leaf === 'headers' || leaf === 'query') return '名称要填';
        return '任务信息没填完整';
      }
      return '任务信息没填完整';
    }
    if (second === 'result') {
      if (third === 'media_field_paths') return '至少要给一个产物路径';
      if (third === 'identity_field_path') return '再取一次的标识路径要填';
      if (third === 'content_url_template') return '内容地址要填';
      if (third === 'after') return '再取一次的结果形态没填完整';
      return '结果形态没填完整';
    }
    return '结果形态没填完整';
  }
  return code === 'unrecognized_keys' ? '这一节的填写有误，请检查' : '';
};

/**
 * 请求体路径为空时，`min(1)` 与正则同时失败；空串已经由「要填」说清，
 * 这里让格式说明只出现在「已填但不合法」的情况，避免同一字段两条互相矛盾的提示。
 */
const isBlankBodyPathValue = (
  path: readonly (string | number)[],
  draft: CustomInterfaceFormatDraft,
): boolean => {
  const head = path[0];
  const isPathLeaf = path[path.length - 1] === 'path';
  if (!isPathLeaf) return false;
  if (head === 'parameters' && path[2] === 'binding' && typeof path[1] === 'number') {
    const binding = draft.parameters[path[1]]?.binding;
    return binding?.location === 'body' && binding.path === '';
  }
  if (head === 'prompt_binding' && path[1] === 'path') {
    return draft.prompt_binding.location === 'body' && draft.prompt_binding.path === '';
  }
  if (head === 'model_binding' && path[1] === 'path') {
    return draft.model_binding?.location === 'body' && draft.model_binding.path === '';
  }
  if (head === 'media_slots' && path[2] === 'field_key' && typeof path[1] === 'number') {
    return draft.media_slots[path[1]]?.field_key === '';
  }
  return false;
};

const isPathAt = (
  path: readonly (string | number)[],
  expected: readonly (string | number)[],
): boolean =>
  path.length === expected.length && expected.every((segment, index) => path[index] === segment);

/**
 * 相对路径 refine 在空串上也会触发；空串已经由 `min(1)` 报「要填」，
 * 这里让格式说明只出现在「已填但不合法」的情况，避免同一字段两条互相矛盾的提示。
 */
const isBlankRelativePath = (
  path: readonly (string | number)[],
  draft: CustomInterfaceFormatDraft,
): boolean => {
  if (path[0] === 'submit' && path[1] === 'path') return draft.submit.path === '';
  if (path[0] === 'behavior' && path[1] === 'async' && path[2] === 'polling' && path[3] === 'path') {
    return draft.behavior.async?.polling.path === '';
  }
  return false;
};

/**
 * `behavior.result` 是判别联合：空产物路径会让 zod 只报一个 `invalid_union`，
 * 具体缺哪一项藏在分支错误里。按状态里的结果形态重跑对应分支 schema，取回精确路径。
 */
const expandResultUnion = (build: InterfaceFormatDraftBuild): SchemaIssue[] => {
  const result = build.draft.behavior.result;
  const parsed = result.kind === 'direct_url'
    ? RecipeDirectUrlResultSchema.safeParse(result)
    : result.kind === 'inline_media'
      ? RecipeInlineMediaResultSchema.safeParse(result)
      : RecipeNeedsFetchResultSchema.safeParse(result);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: ['behavior', 'result', ...issue.path],
  }));
};

export const collectIssues = (state: EditorState): EditorIssue[] => {
  const build = buildInterfaceFormatDraft(state);
  const collected = new Map<string, EditorIssue>();

  const push = (issue: EditorIssue): void => {
    const id = `${issue.fieldId}:${issue.message}`;
    if (collected.has(id)) return;
    collected.set(id, { ...issue, id });
  };

  /**
   * 几个组合约束的错误发生在「A 与 B 不匹配」上：契约把错误挂在 A 的路径下，
   * 但用户该改的是 B。这里把它们指到真正需要修改的控件，避免错误落在看不见的地方。
   */
  const crossFieldTarget = (message: string): IssueTarget | undefined => {
    switch (message) {
      case 'interface_format_model_path_binding_requires_placeholder':
        return fixedTarget('interface-format-submit-path', SECTION_SUBMIT, '提交路径');
      case 'interface_format_text_binding_requires_text_payload':
        return fixedTarget('interface-format-payload-format', SECTION_SUBMIT, '请求体');
      case 'interface_format_text_payload_requires_text_prompt':
        return fixedTarget('interface-format-prompt-location', SECTION_PARAMS, '提示词发送到');
      case 'interface_format_multipart_slot_requires_null_content_type':
        return fixedTarget('interface-format-content-type', SECTION_SUBMIT, 'Content-Type');
      default:
        return undefined;
    }
  };

  const pushSchemaIssue = (issue: SchemaIssue): void => {
    const suppressCodeMessage =
      isBlankRelativePath(issue.path, build.draft) || isBlankBodyPathValue(issue.path, build.draft);
    const codeMessage = suppressCodeMessage ? undefined : CODE_MESSAGES[issue.message];
    const message = codeMessage ?? pathMessage(issue.path, issue.code, state);
    const target = crossFieldTarget(issue.message) ?? targetForPath(issue.path, build, state);
    push({
      id: `${target.fieldId}:${message}`,
      label: target.label,
      message: message === '' ? '这一节的填写有误，请检查' : message,
      sectionId: target.sectionId,
      fieldId: target.fieldId,
      ...(target.rowIndex === undefined ? {} : { rowIndex: target.rowIndex }),
    });
    if (issue.message === NEEDS_FETCH_ASYNC_CODE) {
      push({
        id: 'interface-format-task-mode:needs-fetch-async',
        label: '任务模式',
        message: CODE_MESSAGES[NEEDS_FETCH_ASYNC_CODE] ?? '',
        sectionId: SECTION_TASK,
        fieldId: 'interface-format-task-mode',
      });
    }
  };

  const parsed = CustomInterfaceFormatDraftSchema.safeParse(build.draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === 'invalid_union' && isPathAt(issue.path, ['behavior', 'result'])) {
        for (const nested of expandResultUnion(build)) pushSchemaIssue(nested);
        continue;
      }
      pushSchemaIssue(issue);
    }
  }

  // 契约表达不了：默认值原文能否换成该类型的值（含枚举默认值不在候选里）。
  state.params.forEach((row, rowIndex) => {
    const parsedDefault = parseDefaultValue(row.type, row.defaultValue, row.enumValues);
    if (parsedDefault.ok) return;
    push({
      id: `param-${rowIndex}-default:${parsedDefault.message}`,
      label: rowLabel('参数', rowIndex, '默认值'),
      message: parsedDefault.message,
      sectionId: SECTION_PARAMS,
      fieldId: `interface-format-param-${rowIndex}-default`,
      rowIndex,
    });
  });

  // 契约表达不了：轮询请求体是一段 JSON 文本，能否解析只有界面知道。
  if (state.taskMode === 'async' && state.pollingMethod === 'POST') {
    const pollingBody = parsePollingBody(state.pollingBody);
    if (!pollingBody.ok) {
      push({
        id: `polling-body:${pollingBody.message}`,
        label: '轮询请求体',
        message: pollingBody.message,
        sectionId: SECTION_TASK,
        fieldId: 'interface-format-polling-body',
      });
    }
  }

  // 提示词与参数在同一命名空间（请求体）重叠时，契约只指向提示词字段；同时在具体参数行指出冲突。
  if (state.promptLocation === 'body') {
    const promptPath = state.promptKey.trim();
    if (promptPath !== '') {
      const conflictMessage = CODE_MESSAGES[PROMPT_CONFLICT_CODE] ?? '';
      state.params.forEach((row, rowIndex) => {
        if (row.location !== 'body') return;
        if (!interfaceFormatBodyPathsOverlap(row.key.trim(), promptPath)) return;
        push({
          id: `param-${rowIndex}-key:prompt-conflict`,
          label: rowLabel('参数', rowIndex, parameterKeyLabel(row.location)),
          message: conflictMessage,
          sectionId: SECTION_PARAMS,
          fieldId: `interface-format-param-${rowIndex}-key`,
          rowIndex,
        });
      });
    }
  }

  // 契约表达不了：详情判不出载体时界面回填空串，草稿会临时用 public_url 占位；
  // 这里拦住「用户还没选上传方式」的非空素材位行，避免占位值被当成用户选择。
  state.mediaSlots.forEach((row, rowIndex) => {
    if (isBlankMediaSlotRow(row, state.payloadFormat)) return;
    if (row.carrier !== '') return;
    push({
      id: `media-${rowIndex}-carrier:missing`,
      label: rowLabel('素材位', rowIndex, '上传方式'),
      message: '请选择上传方式',
      sectionId: SECTION_MEDIA,
      fieldId: `interface-format-media-${rowIndex}-carrier`,
      rowIndex,
    });
  });

  return Array.from(collected.values());
};

/** 把同一字段的多条错误合并成一组，供行内 `IssueLine` 渲染与 `aria-describedby` 判定。 */
export const groupIssuesByField = (issues: readonly EditorIssue[]): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    const messages = grouped.get(issue.fieldId);
    if (messages === undefined) {
      grouped.set(issue.fieldId, [issue.message]);
    } else if (!messages.includes(issue.message)) {
      messages.push(issue.message);
    }
  }
  return grouped;
};
