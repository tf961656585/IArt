import { useEffect, useState, type ReactNode } from 'react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } from '@iart/ui';
import type {
  CustomChatModel,
  CustomGenerationModel,
  ExecutableModelDirectoryEntry,
  ModelDeployment,
  ProviderConnection,
} from '@iart/contracts';
import { InfoHint } from './InfoHint';
import { MODEL_FAILURE_MESSAGE } from './invalidity';
import { StatusPill } from './ProviderNoticeBar';

/**
 * 服务商详情（列表右侧那一栏）：服务商自身状态与动作 + 模型清单。
 *
 * 从 `ProviderSection` 拆出：分区容器负责取数、装配与各弹层的开关，详情视图只负责一棵视图树。
 * 模型清单按接入载体并排陈列两类行（spec 03 §6.1「记录即接入」）：
 * - 已装能力包模型的接入行（ModelDeployment）：行内改「模型 ID」、行内「移除」只摘这条接入；
 * - 自建模型记录行（对话与生成）：记录归属创建它的连接，行内「修改」改模型配置、
 *   生成侧行上还有「删除模型」；没有「移除」（记录即接入，摘掉接入等于删掉模型），
 *   也没有行内改名（记录的「服务商那边的模型 ID」不提供修改，spec 03 §6.1）。
 * 另有：设为 / 取消形态默认模型（Agent 形态与生成形态各一个）——形态默认按**行本身**分流
 * （2026-09-26 起协议归属模型级）：对话模型（自建记录）挂 Agent 默认，其余行挂生成默认。
 * 连接上没有接口类型可看（2026-09-29 起摘除连接级预选）：接口类型只属于模型，
 * 在添加模型时配置，一条连接可以混着放两种模型。
 */

/** 模型清单里的一行：接入载体按模型来源分流（已装包模型 / 自建模型记录两族）。 */
type ModelRow =
  | { kind: 'installed'; deployment: ModelDeployment }
  | { kind: 'custom-chat'; record: CustomChatModel }
  | { kind: 'custom-generation'; record: CustomGenerationModel };

/** 二级选择的选项：添加模型前先问加哪一类（2026-09-29 起它是唯一入口，没有预选分流）。 */
export type AddModelKind = 'generation' | 'chat';

export function ProviderDetail({
  connection,
  catalog,
  chatCatalog,
  deployments,
  customChatModels,
  customGenerationModels,
  activeRoutes,
  onEdit,
  onCredential,
  onToggle,
  onClearCredential,
  onDelete,
  onAddModelByKind,
  onRenameModel,
  onRemoveModel,
  onEditChatModel,
  agentDefaultModelId,
  onToggleAgentDefault,
  generationDefaultModelId,
  onToggleGenerationDefault,
  onDeleteGenerationModel,
  onEditGenerationModel,
  modelListUnavailable,
}: {
  connection: ProviderConnection;
  /** 可执行模型目录（自带包模型与自建生成模型的族模板合成投影） */
  catalog: ExecutableModelDirectoryEntry[];
  /** 对话模型目录（对话模型不进可执行目录，只在这里做行状态判定） */
  chatCatalog: ExecutableModelDirectoryEntry[];
  /** 已装能力包模型在本服务商下的接入行 */
  deployments: ModelDeployment[];
  /** 归属本服务商的自建对话模型记录（记录即接入） */
  customChatModels: CustomChatModel[];
  /** 模型清单是否不可用（可执行目录或自建对话清单任一读不到；与「清单为空」区分：读不到时不说「还没有模型」） */
  modelListUnavailable: boolean;
  /** 归属本服务商的自建生成模型记录（记录即接入） */
  customGenerationModels: CustomGenerationModel[];
  activeRoutes: Record<string, string>;
  onEdit: () => void;
  onCredential: () => void;
  onToggle: () => void;
  onClearCredential: () => void;
  onDelete: () => void;
  /** 二级选择：先问加「生成模型」还是「对话模型」，再由容器开对应表单（添加模型的唯一入口） */
  onAddModelByKind: (kind: AddModelKind) => void;
  onRenameModel: (deploymentId: string, modelId: string, remoteModelId: string) => void;
  onRemoveModel: (deploymentId: string, modelId: string) => void;
  /** 改一个自建对话模型记录的能力与思考档位（档位随记录走） */
  onEditChatModel: (record: CustomChatModel) => void;
  /** 当前 Agent 形态的默认模型（本机配置）；null = 没设默认 */
  agentDefaultModelId: string | null;
  /** 设为 / 取消 Agent 默认模型（已在默认位上的模型再点一次即取消） */
  onToggleAgentDefault: (modelId: string) => void;
  /** 当前生成形态的默认模型（本机配置）；null = 没设默认 */
  generationDefaultModelId: string | null;
  /** 设为 / 取消生成默认模型（已在默认位上的模型再点一次即取消） */
  onToggleGenerationDefault: (modelId: string) => void;
  /** 删除一个自建生成模型（记录本身，active 接入由后端级联清理；确认弹层由容器编排） */
  onDeleteGenerationModel: (modelId: string) => void;
  /** 打开一个自建生成模型的「编辑」弹层（参数覆盖与参考图开关，保存走 PUT） */
  onEditGenerationModel: (record: CustomGenerationModel) => void;
}) {
  // retired 不提供任何编辑入口（spec §7.5）：服务商动作排、添加入口与行内「修改」都随它隐藏；
  // 已装包模型行塌缩为单行只读投影（visual-design §8.6 律二）——行内编辑排（含行 2 动作）整段不渲染，
  // 模型 ID 以纯文本呈现，不出禁用态输入框；disabled 只停用生成参与，服务商可编辑，动作排照常渲染
  const editable = connection.lifecycle !== 'retired';
  // 模型清单：接入行与自建记录行并排陈列（记录也归属连接、也是接入载体）。
  // 行内动作按行类型分流，见各类行自己的渲染分支。
  const rows: ModelRow[] = [
    ...deployments.map((deployment): ModelRow => ({ kind: 'installed', deployment })),
    ...customChatModels.map((record): ModelRow => ({ kind: 'custom-chat', record })),
    ...customGenerationModels.map((record): ModelRow => ({ kind: 'custom-generation', record })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h4 className="text-sm font-semibold">{connection.display_name}</h4>
        <StatusPill
          tone={connection.lifecycle !== 'enabled' ? 'bad' : connection.has_credential ? 'ok' : 'warn'}
          label={
            connection.lifecycle !== 'enabled' ? '已停用' : connection.has_credential ? '已启用' : '缺少密钥'
          }
        />
      </div>

      {/* 字段行式列表（visual-design §8.2）：label 左、值右，不再两列均分格 */}
      <div className="flex flex-col gap-2 text-xs">
        <ReadonlyField label="服务地址" value={connection.base_url} />
        <ReadonlyField label="密钥" value={connection.has_credential ? '已设置' : '未设置'} />
      </div>

      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>修改</Button>
          <Button size="sm" variant="outline" onClick={onCredential}>
            {connection.has_credential ? '更换密钥' : '插入密钥'}
          </Button>
          <Button size="sm" variant="outline" onClick={onToggle}>
            {connection.lifecycle === 'enabled' ? '停用' : '启用'}
          </Button>
          {/* 破坏性动作独立成组（visual-design §8.6 律三）：删除类不混入常规动作组，
              组内 4px、与常规组之间 8px（外层 gap-2）+ 语义色隔离；
              行内危险动作统一 ghost-destructive 形态（按钮样式标准 §4），不再手写 text-destructive */}
          <div className="flex items-center gap-1">
            {connection.has_credential ? (
              <Button size="sm" variant="ghost-destructive" onClick={onClearCredential}>删除密钥</Button>
            ) : null}
            <Button size="sm" variant="ghost-destructive" onClick={onDelete}>删除</Button>
          </div>
        </div>
      ) : null}

      {/* 律三间隙阶梯（visual-design §8.6）：组头「模型列表」→首行与行间统一 8px（gap-2） */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-2xs font-semibold tracking-wider text-muted-foreground">模型列表</span>
          {/* 单一「添加模型」入口（2026-09-26 界面收敛；2026-09-29 起连接级预选摘除）：
              每条可编辑的连接都只有这一个按钮，恒先出二级选择（生成模型 / 对话模型）
              再由容器开对应表单——接口类型只在添加模型时配置，连接上没有预选可言。
              retired 不给任何入口（不提供必然失败的入口，也不解释为什么没有）；disabled 保留，
              提交前会拦下并指向同一屏的「启用」 */}
          <div className="flex items-center gap-2">
            {editable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">添加模型</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onAddModelByKind('generation')}>生成模型</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAddModelByKind('chat')}>对话模型</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {/* 空态先分「读不到」与「真的没有」：清单读不到时不能说「还没有模型」
                把人引去重新添加（清单不可用与清单为空必须区分，spec §5）。
                连接可混放两种模型，空态不再按连接协议分措辞，只有一种。 */}
            {modelListUnavailable
              ? '暂时读不到模型清单，点「刷新」再试。'
              : editable
                ? '这个服务商还没有模型。点上面的「添加模型」加几个。'
                : '这个服务商还没有模型。'}
          </p>
        ) : (
          rows.map((row) => {
            // 已装包模型行与自建记录行共用的判定材料：目录投影（唯一状态事实源）与 active route
            const modelId = row.kind === 'installed' ? row.deployment.model_id : row.record.model_id;
            // 行状态按行类型选目录：对话行查对话目录，其余行（已装包模型与自建生成记录）
            // 查可执行目录——一条连接可以混放两种模型，单一目录查不全
            //（2026-09-29 摘除连接级预选后的必要修正，此前按连接协议只查一个目录）。
            const rowCatalog = row.kind === 'custom-chat' ? chatCatalog : catalog;
            const entry = rowCatalog.find((item) => item.model_id === modelId) ?? null;
            // 自建记录行不出现「当前未使用」（记录只归属创建它的连接，没有第二条接入可比较）；
            // 已装包模型行按 active route 判定本行是不是当前生效的那条接入。
            const isActive = row.kind === 'installed'
              ? activeRoutes[row.deployment.model_id] === row.deployment.deployment_id
              : true;
            const ready = entry !== null && entry.deployment.deployable && isActive;
            // 目录读不到时不给失效原因：否则每行都会判红「配置不完整」，
            // 与同屏那句「暂时读不到模型清单，点「刷新」再试。」自相矛盾。
            const status = !isActive
              ? { tone: 'idle' as const, label: '当前未使用' }
              : entry === null
                ? { tone: 'idle' as const, label: '状态未知' }
                : ready
                  ? { tone: 'ok' as const, label: '可用' }
                  : { tone: 'warn' as const, label: MODEL_FAILURE_MESSAGE[entry.deployment.failure_code] || '配置不完整' };
            // 生成默认按钮：非对话行都挂它（协议归属模型级），但两行的渲染位置不同——
            // 自建生成记录行在行 1 动作组，已装包模型行随行 2（见下）；按行类型互斥渲染，
            // 提为共用元素避免两份重复的按钮与文案
            const generationDefaultButton = (
              <Button
                size="sm"
                variant="ghost"
                aria-label={
                  generationDefaultModelId === modelId
                    ? `取消「${modelId}」作为生成默认模型`
                    : `把「${modelId}」设为生成默认模型`
                }
                onClick={() => onToggleGenerationDefault(modelId)}
              >
                {/* 同 Agent 默认：已设时行里有「生成默认」徽章指认对象，「默认」就够；
                    还没设时行里没有任何「生成」字样，所以这个状态下把对象写进按钮本身
                    （口径见 ui-copy-standard 对象指认优先级） */}
                {generationDefaultModelId === modelId ? '取消默认' : '设为生成默认'}
              </Button>
            );
            return (
              <div
                key={row.kind === 'installed' ? row.deployment.deployment_id : row.record.record_id}
                className="flex flex-col gap-1 rounded-md bg-elevated px-3 py-2"
              >
                {/* 两行制行式承载（hub-information-architecture §7.2；行高由内容+呼吸推导，
                    visual-design §8.6 律二）：行 1 = 模型 ID + 默认徽章 + 状态徽章；
                    行 2 = 「服务商那边的模型 ID」行内编辑 + 动作组（仅已装包模型行且连接可编辑；
                    自建记录行没有行 2，动作组留在行 1；retired 连接的已装包模型行塌缩单行只读，
                    行 2 整段不渲染）。已装包模型的动作（设为生成默认 / 移除）作用在这条接入映射
                    本身，所以随行 2 走。行可见性由表面阶梯承载、不靠 border（visual-design §9.1）；
                    行 1↔行 2 为行内从属两行，4px（律三 gap-1）。
                    行高核算（§8.6 律二 anatomy）：installed = py-2(8) + 行1(20，pill 瘦身后不撑高)
                    + gap-1(4) + 行2(32，h-8 输入与 sm 按钮同档) + py-2(8) = 72px（两行制地板）；
                    custom 单行 = 8 + 32 + 8 = 48px（含 32px 控件单行） */}
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={modelId}>
                    {modelId}
                  </span>
                  {agentDefaultModelId === modelId ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground">
                        Agent 默认
                      </span>
                      {/* 说明挂在它讲的那个对象上：解释留在这一行之外会被读成在讲「模型列表」 */}
                      <InfoHint
                        text="画布里切到 Agent、还没选过模型时，会自动选它。"
                        subject={`「${modelId}」作为 Agent 默认模型`}
                      />
                    </span>
                  ) : null}
                  {generationDefaultModelId === modelId ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground">
                        生成默认
                      </span>
                      {/* 说明挂在它讲的那个对象上：解释留在这一行之外会被读成在讲「模型列表」 */}
                      <InfoHint
                        text="画布里的生成形态还没选过模型时，会自动选它。"
                        subject={`「${modelId}」作为生成默认模型`}
                      />
                    </span>
                  ) : null}
                  {/* leading-none：裸 span 包裹会继承 16px/24px 行盒、把 flex 项撑到 24.5px（徽章本体 19.9），
                      压掉行盒后行 1 高度由徽章本体决定（≈20px） */}
                  <span className="shrink-0 leading-none">
                    <StatusPill tone={status.tone} label={status.label} />
                  </span>
                  {/* 行 1 动作组（仅自建模型行）：动作就近靠右（§8.5 拉空改就近）；
                      按钮 size/variant/文案与按行分流一字不动 */}
                  {row.kind !== 'installed' ? (
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      {/* 自建对话模型行：行内「修改」是能力与档位的唯一改动入口（档位随记录走） */}
                      {row.kind === 'custom-chat' && editable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`修改「${row.record.model_id}」的配置`}
                          onClick={() => onEditChatModel(row.record)}
                        >
                          修改
                        </Button>
                      ) : null}
                      {/* 两种形态默认按行本身的模型类型分流（协议归属模型级）：对话模型（自建记录）
                          挂 Agent 默认；生成默认挂非对话行——自建生成记录行在行 1、
                          已装包模型行随行 2（按钮见上方 generationDefaultButton） */}
                      {row.kind === 'custom-chat' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={
                            agentDefaultModelId === modelId
                              ? `取消「${modelId}」作为 Agent 默认模型`
                              : `把「${modelId}」设为 Agent 默认模型`
                          }
                          onClick={() => onToggleAgentDefault(modelId)}
                        >
                          {/* 已设为默认时同一行有「Agent 默认」徽章指认对象，「默认」就够；
                              还没设时行里没有任何「Agent」字样，所以这个状态下把对象写进按钮本身
                              （口径见 ui-copy-standard 对象指认优先级） */}
                          {agentDefaultModelId === modelId ? '取消默认' : '设为 Agent 默认'}
                        </Button>
                      ) : null}
                      {row.kind === 'custom-generation' ? generationDefaultButton : null}
                      {/* 自建生成模型行：记录可改可删（修改保存走 PUT，删除级联清 active 接入与「当前使用」）。
                          已装模型行没有这两样——参数表单与请求规则在包定义里，行内「移除」只摘接入 */}
                      {row.kind === 'custom-generation' && editable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`修改「${row.record.model_id}」的配置`}
                          onClick={() => onEditGenerationModel(row.record)}
                        >
                          修改
                        </Button>
                      ) : null}
                      {row.kind === 'custom-generation' && editable ? (
                        <Button
                          size="sm"
                          variant="ghost-destructive"
                          aria-label={`删除模型「${row.record.model_id}」`}
                          onClick={() => onDeleteGenerationModel(row.record.model_id)}
                        >
                          删除模型
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {row.kind === 'installed' && editable ? (
                  /* retired 连接不渲染行内编辑排（§8.6 律二塌缩单行只读；§7.5 不提供必然失败的入口）：
                      行 2 连同「设为生成默认 / 移除」一起消失，行 1 只读投影承担全部信息 */
                  <ModelNameInput
                    modelId={row.deployment.model_id}
                    value={row.deployment.remote_model_id}
                    onCommit={(next) => onRenameModel(row.deployment.deployment_id, row.deployment.model_id, next)}
                    actions={
                      <div className="flex shrink-0 items-center gap-1">
                        {generationDefaultButton}
                        {/* 「移除」只对已装包模型行出现：自建记录即接入，摘掉接入等于删掉模型，
                            那个动作叫「删除模型」，不叫「移除」（spec §4.4）。
                            移除是行内卸除类动作 → ghost-destructive（按钮样式标准 §4） */}
                        <Button
                          size="sm"
                          variant="ghost-destructive"
                          aria-label={`移除 ${row.deployment.model_id}`}
                          onClick={() => onRemoveModel(row.deployment.deployment_id, row.deployment.model_id)}
                        >
                          移除
                        </Button>
                      </div>
                    }
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 「模型 ID」内联编辑：失焦或回车时提交，与当前值相同则不提交。
 * 只在可编辑连接上挂载（retired 连接整段不渲染，§7.5 / visual-design §8.6 律二塌缩单行只读）。
 * 行 2 可在输入框之后挂动作组（actions）：已装包模型行的「设为生成默认 / 移除」作用在这条接入映射本身，
 * 随行 2 排布——行 2 高度由 32px 档输入与按钮共同决定（律一行内编辑排同高），是两行制行高预算的承担者。 */
function ModelNameInput({
  modelId,
  value,
  onCommit,
  actions,
}: {
  modelId: string;
  value: string;
  onCommit: (next: string) => void;
  /** 行 2 末尾动作组（仅已装包模型行传入）：与输入框之间 gap-2，shrink-0 不参与压缩 */
  actions?: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    const next = draft.trim();
    if (next !== '' && next !== value) onCommit(next);
    else if (next === '') setDraft(value);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-2xs text-muted-foreground">服务商那边的模型 ID</span>
      <Input
        aria-label={`${modelId} 的服务商那边的模型 ID`}
        className="h-8 min-w-30 flex-1 text-2xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {actions ?? null}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-xs">{value}</span>
    </div>
  );
}
