import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@iart/ui';
import type {
  CustomChatModel,
  CustomGenerationModel,
  ExecutableModelDirectoryEntry,
  InterfaceRecipe,
} from '@iart/contracts';
import { MoreHorizontal, Star } from 'lucide-react';
import {
  MODEL_FAILURE_MESSAGE,
  RECIPE_MISSING_BADGE_LABEL,
  RECIPE_MISSING_HINT,
  RECIPE_MISSING_HINT_READONLY,
  resolveRecipeReferenceState,
  type RecipeReferenceState,
} from './invalidity';
import { InfoHint } from './InfoHint';
import { StatusDot } from './StatusDot';
import type { BindingTone } from './ProviderNoticeBar';

/**
 * 服务商详情里的模型清单（表格承载）。
 *
 * 为什么是表格而不是两行卡（2026-10-19）：原两行制的前提是「详情只有 495px，装不下四列 + 全文案
 * 动作按钮」（IA §7.2 2026-09-29 裁定）。设置页改为分区成页后详情 ≥640px，该前提失效；
 * 列排让模型 ID / 服务商模型 ID / 状态 / 默认各自成为稳定列，比两行更容易横向扫读，
 * 且行内动作收进 ⋯ 菜单后不再与模型名抢宽度。
 *
 * 两类行共用一套列（spec 03 §6.1 单一载体，2026-10-19）：
 * - custom-chat / custom-generation：用户模型记录，记录归属创建它的连接
 *
 * 行不区分来源：界面上只有一种对象「模型」（`docs/ui-copy-standard.md`「来源区分」禁用行）。
 * 两族行的动作因此同形——「修改配置」+ 各自配置弹层里的「删除模型」；没有「从本服务商移除」，
 * 因为模型只有记录这一处载体，删掉即消失，不存在「摘掉接入、本体留着」的第二状态。
 */

export type ModelRow =
  | { kind: 'custom-chat'; record: CustomChatModel }
  | { kind: 'custom-generation'; record: CustomGenerationModel };

export interface ModelTableProps {
  rows: ModelRow[];
  /** 可执行模型目录：服务 custom-generation 行的状态判定 */
  catalog: ExecutableModelDirectoryEntry[];
  /** 对话模型目录：只服务 custom-chat 行（对话模型不进可执行目录） */
  chatCatalog: ExecutableModelDirectoryEntry[];
  /** 连接是否可编辑（retired 连接的行塌缩为只读投影，不渲染任何入口） */
  editable: boolean;
  modelListUnavailable: boolean;
  /** 接口配方公共库：判定记录的配方引用是否仍生效（行内「配方已失效」标记） */
  interfaceRecipes: InterfaceRecipe[];
  /** 配方库读取失败：未知不等于缺失，不据此标记任何记录 */
  interfaceRecipesUnavailable: boolean;
  agentDefaultModelId: string | null;
  generationDefaultModelId: string | null;
  onToggleAgentDefault: (modelId: string) => void;
  onToggleGenerationDefault: (modelId: string) => void;
  onEditChatModel: (record: CustomChatModel) => void;
  onEditGenerationModel: (record: CustomGenerationModel) => void;
  onDeleteGenerationModel: (modelId: string) => void;
  /** 空态里的「添加模型」入口（retired 连接不传，不提供必然失败的入口） */
  onAddModel?: () => void;
}

export function ModelTable(props: ModelTableProps) {
  const { rows, editable, modelListUnavailable } = props;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center">
        <p className="text-xs text-muted-foreground">
          {/* 空态先分「读不到」与「真的没有」：清单读不到时说「还没有模型」会把人引去重复添加 */}
          {modelListUnavailable
            ? '暂时读不到模型清单，点「刷新」再试。'
            : editable
              ? '这个服务商还没有模型。'
              : '这个服务商还没有模型。'}
        </p>
        {/* 空态不再挂「添加模型」按钮（2026-10-19）：详情头同一位置已有该入口，
            同屏两个同名按钮违反 ui-copy-standard 第 8 条（同名概念必须能分清各自指哪个），
            且空态那句「点上面的「添加模型」」本来就在指详情头那个——多一个按钮反而让指代变糊。
            空态只承担「这里为什么空」，入口唯一性由详情头保证。 */}
        {modelListUnavailable ? null : editable ? (
          <p className="text-2xs text-muted-foreground">用上面的「添加模型」把要用的模型加进来。</p>
        ) : null}
      </div>
    );
  }

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <caption className="sr-only">这个服务商下已添加的模型</caption>
      <thead>
        <tr className="border-b border-data text-2xs text-muted-foreground">
          <th scope="col" className="h-8 px-3 font-medium">模型</th>
          <th scope="col" className="h-8 px-3 font-medium">服务商模型 ID</th>
          <th scope="col" className="h-8 w-26 px-3 font-medium">状态</th>
          <th scope="col" className="h-8 w-23 px-3 font-medium">默认</th>
          <th scope="col" className="h-8 w-11 px-3">
            <span className="sr-only">操作</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ModelTableRow key={rowKey(row)} row={row} {...props} />
        ))}
      </tbody>
    </table>
  );
}

const rowKey = (row: ModelRow): string => row.record.record_id;

function ModelTableRow({
  row,
  catalog,
  chatCatalog,
  editable,
  interfaceRecipes,
  interfaceRecipesUnavailable,
  agentDefaultModelId,
  generationDefaultModelId,
  onToggleAgentDefault,
  onToggleGenerationDefault,
  onEditChatModel,
  onEditGenerationModel,
  onDeleteGenerationModel,
}: ModelTableProps & { row: ModelRow }) {
  const modelId = row.record.model_id;
  // 行状态按行类型选目录：对话行查对话目录，其余行查可执行目录——
  // 一条连接可以混放两种模型，单一目录查不全。
  const rowCatalog = row.kind === 'custom-chat' ? chatCatalog : catalog;
  const entry = rowCatalog.find((item) => item.model_id === modelId) ?? null;

  const status: { tone: BindingTone; label: string } = entry === null
    ? { tone: 'idle', label: '状态未知' }
    : entry.deployment.deployable
      ? { tone: 'ok', label: '可用' }
      : { tone: 'warn', label: MODEL_FAILURE_MESSAGE[entry.deployment.failure_code] || '配置不完整' };

  /**
   * 配方引用状态（`docs/custom-providers/接口配方-design.md` §8.5）：
   * 只有生成族记录能引用配方；缺失时运行时已回落内置默认，行内必须可见。
   */
  const recipeState: RecipeReferenceState = row.kind === 'custom-generation'
    ? resolveRecipeReferenceState({
        recipeId: row.record.recipe_id,
        familyAdapterId: row.record.family_adapter_id,
        recipes: interfaceRecipes,
        recipesUnavailable: interfaceRecipesUnavailable,
      })
    : 'none';

  const isAgentDefault = agentDefaultModelId === modelId;
  const isGenerationDefault = generationDefaultModelId === modelId;
  // 只有「这一行用得上」的默认位才出现在默认列：对话模型挂 Agent 默认，其余行挂生成默认
  const defaultKind: 'agent' | 'generation' | null =
    row.kind === 'custom-chat' ? 'agent' : 'generation';
  const isDefault = defaultKind === 'agent' ? isAgentDefault : isGenerationDefault;

  return (
    <tr className="border-b border-data" data-model-row={row.kind}>
      {/* 模型列：model_id 直显不翻译（AGENTS.md），不挂来源标签（界面无来源区分） */}
      <td className="h-13 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs font-medium" title={modelId}>{modelId}</span>
          {/* 配方失效标记：非交互徽章 + 同行「?」说明（不新增按钮）。
              只在「已成功读到配方库、且这条引用解析不到」时出现；配方库读不到不标。 */}
          {recipeState === 'missing' ? (
            <span className="flex shrink-0 items-center gap-1">
              <span className="whitespace-nowrap rounded-sm border border-warning/40 px-1 text-2xs text-warning">
                {RECIPE_MISSING_BADGE_LABEL}
              </span>
              <InfoHint
                text={editable ? RECIPE_MISSING_HINT : RECIPE_MISSING_HINT_READONLY}
                subject={`「${modelId}」的接口配方`}
              />
            </span>
          ) : null}
          {isDefault ? (
            <span className="flex shrink-0 items-center gap-1">
              <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground">
                {defaultKind === 'agent' ? 'Agent 默认' : '生成默认'}
              </span>
              <InfoHint
                text={
                  defaultKind === 'agent'
                    ? '画布里切到 Agent、还没选过模型时，会自动选它。'
                    : '画布里的生成形态还没选过模型时，会自动选它。'
                }
                subject={`「${modelId}」作为${defaultKind === 'agent' ? ' Agent 默认' : '生成默认'}模型`}
              />
            </span>
          ) : null}
        </div>
      </td>

      {/* 服务商模型 ID 列：等宽值。记录的线上模型名不提供修改——改它等于换一个远端模型，
          spec 03 §6.1 把它归到「删除后重建」，所以这一列是只读投影。 */}
      <td className="h-13 px-3">
        <span className="block truncate font-mono text-2xs text-muted-foreground" title={row.record.remote_model_id}>
          {row.record.remote_model_id || modelId}
        </span>
      </td>

      {/* 状态列：点 + 文字（不再每行一个胶囊，胶囊只留给异常） */}
      <td className="h-13 px-3">
        <StatusDot tone={status.tone} label={status.label} />
      </td>

      {/* 默认列：星标按钮（实心 = 当前默认），不占动作列 */}
      <td className="h-13 px-3">
        {editable ? (
          <Button
            size="2xs"
            variant="ghost"
            aria-pressed={isDefault}
            aria-label={
              isDefault
                ? `取消「${modelId}」的默认`
                : defaultKind === 'agent'
                  ? `把「${modelId}」设为 Agent 默认模型`
                  : `把「${modelId}」设为生成默认模型`
            }
            className="shrink-0"
            onClick={() => (defaultKind === 'agent' ? onToggleAgentDefault(modelId) : onToggleGenerationDefault(modelId))}
          >
            <Star
              className={isDefault ? 'h-3.5 w-3.5 fill-current' : 'h-3.5 w-3.5'}
              aria-hidden="true"
            />
          </Button>
        ) : (
          <span className="text-2xs text-muted-foreground">{isDefault ? '默认' : ''}</span>
        )}
      </td>

      {/* 操作列：⋯ 菜单。破坏性项在菜单内独立成组（visual-design §8.6 律三） */}
      <td className="h-13 px-3">
        {editable ? (
          <RowMenu
            row={row}
            modelId={modelId}
            onEditChatModel={onEditChatModel}
            onEditGenerationModel={onEditGenerationModel}
            onDeleteGenerationModel={onDeleteGenerationModel}
          />
        ) : null}
      </td>
    </tr>
  );
}

/** 行「⋯」菜单：改配置 / 删除模型，破坏性项独立成组。 */
function RowMenu({
  row,
  modelId,
  onEditChatModel,
  onEditGenerationModel,
  onDeleteGenerationModel,
}: {
  row: ModelRow;
  modelId: string;
  onEditChatModel: (record: CustomChatModel) => void;
  onEditGenerationModel: (record: CustomGenerationModel) => void;
  onDeleteGenerationModel: (modelId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="2xs"
          variant="ghost"
          className="shrink-0"
          aria-label={`「${modelId}」的操作`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {row.kind === 'custom-chat' ? (
          <DropdownMenuItem onSelect={() => onEditChatModel(row.record)}>修改配置</DropdownMenuItem>
        ) : null}
        {row.kind === 'custom-generation' ? (
          <DropdownMenuItem onSelect={() => onEditGenerationModel(row.record)}>修改配置</DropdownMenuItem>
        ) : null}
        {/* 破坏性项独立成组：与「修改配置」之间加分隔线（空间隔离）+ 语义色（语义隔离） */}
        {row.kind === 'custom-generation' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onDeleteGenerationModel(row.record.model_id)}
            >
              删除模型
            </DropdownMenuItem>
          </>
        ) : null}
        {/* 自建对话模型的删除入口在「修改配置」弹层底部（弹层要说明影响面），不在菜单里重复 */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { rowKey };
