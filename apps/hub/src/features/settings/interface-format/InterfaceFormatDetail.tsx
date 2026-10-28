import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@iart/ui';
import type { ReactNode } from 'react';
import type {
  FamilyTemplateOfficialField,
  InterfaceFormatDetail,
  InterfaceFormatModelBinding,
  InterfaceFormatNameValue,
  InterfaceFormatPromptBinding,
  InterfaceFormatResultForm,
  InterfaceFormatTransportAuthView,
} from '@iart/contracts';
import { AlertCircle } from 'lucide-react';
import { InfoHint } from '../provider-connection/InfoHint';
import { StateCard } from '../provider-connection/ProviderDetail';
import { StatusPill } from '../provider-connection/ProviderNoticeBar';

/**
 * 「接口格式」页中栏：选中格式的只读定义（docs/hub/hub-information-architecture.md §7.9）。
 *
 * 本栏只渲染选中格式的定义，不承载编辑动作：预设随软件版本分发（只读，可「复制为我的格式」），
 * 编辑 / 删除只对自建格式出现。三类动作都渲染在详情头部——列表行只承担选中，
 * 不承载动作（选中态口径见 docs/ui-selection-standard.md）。
 *
 * 术语口径：`endpoint` 键名是预设内部结构，界面只显示它解析后的路径
 * （契约注释「界面不展示 endpoint_key 这层内部键名」）；状态文案用「可用 / 还没就绪」，
 * 不直出 `ready` / `pending`。请求落点按用户语言写「请求体 / 查询参数 / 请求头」，
 * 不出现 binding、payload_rules 这类实现词。
 */

const RESULT_FORM_LABELS: Readonly<Record<InterfaceFormatResultForm, string>> = {
  direct_url: '直接给链接',
  inline_media: '直接放在响应里',
  needs_fetch: '还要再取一次',
};

const WIRE_LOCATION_LABELS = {
  body: '请求体',
  query: '查询参数',
  header: '请求头',
} as const;

const PAYLOAD_FORMAT_LABELS = {
  json: 'JSON',
  multipart: '表单文件上传',
  form: '表单（x-www-form-urlencoded）',
  text: '纯文本',
} as const;

const FORM_FIELD_STYLE_LABELS = {
  dotted: '点号分层（a.b）',
  bracket: '方括号（a[b]）',
} as const;

const FORM_ARRAY_STYLE_LABELS = {
  repeat: '重复同名键',
  bracket: '方括号（a[]）',
  index: '下标（a[0]）',
} as const;

/** 鉴权注入位置：请求头三种说法之外还有查询参数。 */
const authText = (auth: InterfaceFormatTransportAuthView): string => {
  if (auth.kind === 'query_api_key') return `放在查询参数（${auth.query_name}）`;
  if (auth.kind === 'bearer') {
    return `放在请求头（${auth.header_name}${auth.prefix === undefined ? '' : ` ${auth.prefix}`}）`;
  }
  return `放在请求头（${auth.header_name}）`;
};

/** 一个值发到哪里：请求体路径 / 查询参数名 / 请求头名 / 纯文本正文 / 地址路径。 */
const bindingText = (
  binding: InterfaceFormatPromptBinding | InterfaceFormatModelBinding | null,
  emptyText: string,
): string => {
  if (binding === null) return emptyText;
  if (binding.location === 'text') return '纯文本正文';
  if (binding.location === 'path') return '地址路径（{model}）';
  const place = WIRE_LOCATION_LABELS[binding.location];
  return binding.location === 'body' ? `${place}（${binding.path}）` : `${place}（${binding.name}）`;
};

const wireLocationText = (location: 'body' | 'query' | 'header'): string =>
  WIRE_LOCATION_LABELS[location];

/** 固定请求头 / 固定查询参数列表；空列表给「没有」。 */
function NameValueList({ entries, emptyText }: { entries: readonly InterfaceFormatNameValue[]; emptyText: string }) {
  if (entries.length === 0) return <span className="text-muted-foreground">{emptyText}</span>;
  return (
    <ul className="flex flex-col gap-1">
      {entries.map((entry, index) => (
        <li key={`${entry.name}-${index}`} className="font-mono text-xs text-muted-foreground">
          {`${entry.name}: ${entry.value}`}
        </li>
      ))}
    </ul>
  );
}

/** 只读值预览：标量原样，复杂值给紧凑 JSON。 */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '（空）' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? '—' : text;
  } catch {
    return '—';
  }
};

/** 轮询间隔按秒展示（契约单位是毫秒，界面不印毫秒）。 */
const intervalText = (intervalMs: number): string => {
  const seconds = intervalMs / 1000;
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
};

function DefinitionSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-2xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{children}</span>
    </div>
  );
}

/** 参数表的「默认值 / 候选值」列：默认值优先，其次枚举候选。 */
const fieldValueText = (field: FamilyTemplateOfficialField): string => {
  if (field.default_value !== null && field.default_value !== undefined) {
    return formatValue(field.default_value);
  }
  if (field.enum_options.length > 0) {
    return field.enum_options.map(formatValue).join(' / ');
  }
  const presetLabels = [...field.resolution_presets, ...field.aspect_presets].map((item) => item.label);
  if (presetLabels.length > 0) return presetLabels.join(' / ');
  return '—';
};

export function InterfaceFormatDefinition({
  detail,
  onAddModel,
  onShowRecipes,
  onCopy,
  copying,
  onEdit,
  onDelete,
}: {
  detail: InterfaceFormatDetail;
  onAddModel: () => void;
  onShowRecipes: () => void;
  /** 复制为我的格式（预设）。 */
  onCopy: () => void;
  /** 复制请求进行中：按钮先禁用，避免连点复制出多份。 */
  copying?: boolean;
  /** 编辑（我的格式）。 */
  onEdit: () => void;
  /** 删除（我的格式）。 */
  onDelete: () => void;
}) {
  const { summary, transport, parameter_descriptor: descriptor, builtin_behavior: behavior } = detail;
  const ready = summary.status === 'ready';
  const userFormat = summary.origin === 'user';

  return (
    <div className="flex min-w-0 flex-col gap-4" data-interface-format-detail>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold">{summary.display_name}</h3>
            <span className="shrink-0 leading-none">
              <StatusPill tone={ready ? 'ok' : 'idle'} label={ready ? '可用' : '还没就绪'} />
            </span>
          </div>
          <p className="truncate text-2xs text-muted-foreground">{summary.format_id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs text-muted-foreground">{`被 ${detail.used_by_model_count} 个模型使用`}</span>
          {userFormat ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={onEdit}>
                编辑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost-destructive"
                onClick={onDelete}
              >
                删除
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!ready || copying === true}
              onClick={onCopy}
            >
              复制为我的格式
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={onAddModel}>
            用此格式添加模型
          </Button>
          <InfoHint
            text="模型在「服务商」页添加：选中一条服务商，点「添加模型」，接口格式选它。"
            subject="用此格式添加模型"
          />
        </div>
      </div>

      {!ready ? (
        <p className="text-xs text-muted-foreground">
          这个格式还没就绪，暂时看不到定义和验证面板。等软件更新后再看。
        </p>
      ) : (
        <>
          {transport === null ? (
            <p className="text-xs text-muted-foreground">这个格式的定义不完整，暂时显示不了提交与轮询信息。</p>
          ) : (
            <>
              <DefinitionSection title="提交">
                <FieldRow label="请求">
                  <span className="font-mono">{`${transport.submit.method} ${transport.submit.path}`}</span>
                </FieldRow>
                <FieldRow label="请求体">{PAYLOAD_FORMAT_LABELS[transport.submit.payload_format]}</FieldRow>
                {transport.submit.payload_format === 'form' ? (
                  <>
                    <FieldRow label="嵌套字段">
                      {FORM_FIELD_STYLE_LABELS[transport.submit.form_field_style]}
                    </FieldRow>
                    <FieldRow label="数组写法">
                      {FORM_ARRAY_STYLE_LABELS[transport.submit.form_array_style]}
                    </FieldRow>
                  </>
                ) : null}
                <FieldRow label="鉴权">{authText(transport.auth)}</FieldRow>
                <FieldRow label="提示词">{bindingText(transport.prompt_binding, '没有设置')}</FieldRow>
                <FieldRow label="模型 ID">{bindingText(transport.model_binding, '不发送')}</FieldRow>
                <FieldRow label="固定请求头">
                  <NameValueList entries={transport.submit.headers} emptyText="没有" />
                </FieldRow>
                <FieldRow label="固定查询参数">
                  <NameValueList entries={transport.submit.query} emptyText="没有" />
                </FieldRow>
                <div className="flex flex-col gap-1">
                  <span className="text-2xs text-muted-foreground">可选地址</span>
                  <ul className="flex flex-col gap-1">
                    {Object.values(transport.endpoints).map((path) => (
                      <li key={path} className="font-mono text-xs text-muted-foreground">{path}</li>
                    ))}
                  </ul>
                </div>
              </DefinitionSection>

              {transport.async === null ? null : (
                <DefinitionSection title="轮询">
                  <FieldRow label="任务标识">
                    <span className="font-mono">{transport.async.identity_path}</span>
                  </FieldRow>
                  <FieldRow label="查询地址">
                    <span className="font-mono">{`${transport.async.polling.method} ${transport.async.polling.url_template}`}</span>
                  </FieldRow>
                  <FieldRow label="查询节奏">
                    {`每 ${intervalText(transport.async.polling.interval_ms)}查一次，最多 ${transport.async.polling.max_attempts} 次`}
                  </FieldRow>
                  <FieldRow label="请求头">
                    <NameValueList entries={transport.async.polling.headers} emptyText="没有" />
                  </FieldRow>
                  <FieldRow label="查询参数">
                    <NameValueList entries={transport.async.polling.query} emptyText="没有" />
                  </FieldRow>
                  {transport.async.polling.body === undefined ? null : (
                    <>
                      <FieldRow label="请求体">{formatValue(transport.async.polling.body)}</FieldRow>
                      <FieldRow label="请求体形态">
                        {transport.async.polling.body_format === 'form' ? 'x-www-form-urlencoded' : '结构化 JSON'}
                      </FieldRow>
                      <FieldRow label="Content-Type">
                        {formatValue(transport.async.polling.content_type)}
                      </FieldRow>
                    </>
                  )}
                </DefinitionSection>
              )}
            </>
          )}

          <DefinitionSection title="参数">
            {descriptor === null || descriptor.official_fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">这个格式没有可填的参数。</p>
            ) : (
              <div className="overflow-hidden rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>参数</TableHead>
                      <TableHead>发送到</TableHead>
                      <TableHead>必填</TableHead>
                      <TableHead>默认值 / 候选值</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {descriptor.official_fields.map((field) => (
                      <TableRow key={field.field_key}>
                        <TableCell className="font-medium">{field.label}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {`${wireLocationText(field.wire_location)} · `}
                          <span className="font-mono">{field.wire_name}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {field.required ? '必填' : '可选'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fieldValueText(field)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </DefinitionSection>

          <DefinitionSection title="结果与判定">
            {behavior === null ? (
              <p className="text-xs text-muted-foreground">这个格式没有内置判定。</p>
            ) : (
              <div className="flex flex-col gap-1">
                <FieldRow label="内置判定">
                  {behavior.has_success_condition ? '有，按格式自带的成功条件判定' : '没有，全部由配方决定'}
                </FieldRow>
                <FieldRow label="结果形态">
                  {behavior.result_form === null ? '判不出来，由配方决定' : RESULT_FORM_LABELS[behavior.result_form]}
                </FieldRow>
                <FieldRow label="凭证">
                  {behavior.requires_auth ? '取结果时需要凭证' : '取结果时不需要凭证'}
                </FieldRow>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">判定与结果由接口配方承载。</p>
              <Button type="button" size="sm" variant="outline" onClick={onShowRecipes}>
                去判定配方
              </Button>
            </div>
          </DefinitionSection>
        </>
      )}
    </div>
  );
}

/** 详情栏的加载 / 失败两态（未选中格式由中栏的空态兜住）。 */
export function InterfaceFormatDetailPlaceholder({
  kind,
  message,
  onRetry,
}: {
  kind: 'loading' | 'error';
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  if (kind === 'error') {
    return (
      <StateCard
        icon={<AlertCircle className="h-10 w-10" aria-hidden="true" />}
        title="没能读取接口格式定义"
        description={message ?? '网络或后端暂时没有响应。已经配置好的内容不会丢失。'}
        action={onRetry === undefined ? undefined : (
          <Button type="button" size="sm" onClick={onRetry}>重新读取</Button>
        )}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <div className="h-8 w-40 rounded-md bg-muted/60" />
      <div className="h-20 rounded-md bg-muted/60" />
      <div className="h-20 rounded-md bg-muted/60" />
      <span className="sr-only" role="status">正在读取接口格式定义</span>
    </div>
  );
}
