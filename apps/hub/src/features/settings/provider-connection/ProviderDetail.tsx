import type { ReactNode } from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@iart/ui';
import { MoreHorizontal } from 'lucide-react';
import type { ProviderConnection } from '@iart/contracts';
import type { ModelTableProps } from './ModelTable';
import { ModelTable } from './ModelTable';
import { StatusDot } from './StatusDot';

/**
 * 服务商详情：紧凑头部 + 模型表格。
 *
 * 动作分层（2026-10-19，替换原「修改 / 更换密钥 / 停用 / 删除密钥 / 删除」五键同排）：
 * - 主操作「添加模型」（primary）：用户来这里最主要做的事
 * - 次操作「更换密钥 / 设置密钥」（outline）
 * - 「⋯」菜单：修改服务商 / 停用·启用 / 删除密钥 / 删除服务商，后两项独立成组
 *
 * 五键同排的问题是触发点自身不说明后果：「删除」与「删除密钥」都以「删除」开头、相距 4px，
 * 用户只能靠确认框分辨。分层后主次清楚，不可逆动作不在主视线上，
 * 且都带对象全名（`docs/ui-copy-standard.md` 第 10 条）。
 */

export type AddModelKind = 'generation' | 'chat';

export function ProviderDetail({
  connection,
  modelTable,
  onEdit,
  onCredential,
  onToggle,
  onClearCredential,
  onDelete,
  onAddModelByKind,
  onReload,
}: {
  connection: ProviderConnection;
  /** 模型表格的全部数据与回调（本组件的职责是详情头，表格自带渲染） */
  modelTable: ModelTableProps;
  onEdit: () => void;
  onCredential: () => void;
  onToggle: () => void;
  onClearCredential: () => void;
  onDelete: () => void;
  onAddModelByKind: (kind: AddModelKind) => void;
  onReload: () => void;
}) {
  // retired 不提供任何编辑入口（spec §7.5）：动作排、添加模型、「⋯」菜单都随它隐藏，
  // 模型行塌缩为只读投影（visual-design §8.6 律二）。
  // disabled 只停用生成参与，服务商仍可编辑，动作照常渲染。
  const editable = connection.lifecycle !== 'retired';
  const modelCount = modelTable.rows.length;

  return (
    <section className="flex min-w-0 flex-col" data-provider-detail>
      {/* 详情头：名称 + 状态 + 动作（页面头 / 详情头的右对齐动作用 ml-auto 就近靠右，
          不参与 §8.5「标题↔动作 240px 拉空」扫描——那条约束的是卡片内分区标题） */}
      <div className="flex flex-wrap items-start gap-3 px-4 py-3" data-detail-head>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="min-w-0 truncate text-sm font-semibold">{connection.display_name}</h4>
            <StatusDot
              tone={
                connection.lifecycle !== 'enabled' ? 'idle' : connection.has_credential ? 'ok' : 'warn'
              }
              label={
                connection.lifecycle !== 'enabled'
                  ? '已停用'
                  : connection.has_credential
                    ? '已启用'
                    : '缺少密钥'
              }
            />
          </div>
          {/* 第二行：地址 · 密钥状态。**不复读模型数**——模型清单就在正下方、逐行可见
              （2026-09-29 裁定，2026-10-19 沿用） */}
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
            <span className="min-w-0 truncate" title={connection.base_url}>{connection.base_url}</span>
            <span aria-hidden="true">·</span>
            <span>{connection.has_credential ? '密钥已保存' : '还没设置密钥'}</span>
          </p>
        </div>

        {editable ? (
          <div className="flex shrink-0 items-center gap-2">
            <AddModelButton onAddModelByKind={onAddModelByKind} />
            <Button size="sm" variant="outline" onClick={onCredential}>
              {connection.has_credential ? '更换密钥' : '设置密钥'}
            </Button>
            <ProviderMenu
              connection={connection}
              onEdit={onEdit}
              onToggle={onToggle}
              onClearCredential={onClearCredential}
              onDelete={onDelete}
            />
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onReload}>
            刷新
          </Button>
        )}
      </div>

      {/* 模型区：组头（带模型数）+ 「添加模型」入口在详情头，组头只报数量 */}
      <div className="flex items-center gap-2 px-4 pb-2">
        <h5 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          模型清单
        </h5>
        {modelCount > 0 ? (
          <span className="text-2xs text-muted-foreground">{modelCount}</span>
        ) : null}
      </div>
      <div className="px-4 pb-4">
        <ModelTable {...modelTable} onAddModel={() => onAddModelByKind('generation')} />
      </div>
    </section>
  );
}

/** 单一「添加模型」入口：恒先选加哪一类（生成 / 对话），再由容器开对应表单。 */
function AddModelButton({ onAddModelByKind }: { onAddModelByKind: (kind: AddModelKind) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">添加模型</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAddModelByKind('generation')}>生成模型</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAddModelByKind('chat')}>对话模型</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 服务商级「⋯」菜单：常规项与破坏性项分组。 */
function ProviderMenu({
  connection,
  onEdit,
  onToggle,
  onClearCredential,
  onDelete,
}: {
  connection: ProviderConnection;
  onEdit: () => void;
  onToggle: () => void;
  onClearCredential: () => void;
  onDelete: () => void;
}) {
  const hasCredential = connection.has_credential;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="服务商操作">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>修改服务商</DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggle}>
          {connection.lifecycle === 'enabled' ? '停用' : '启用'}
        </DropdownMenuItem>
        {/* 破坏性项独立成组（visual-design §8.6 律三）：分隔线做空间隔离 + 语义色做语义隔离；
            两项都带对象全名（ui-copy-standard 第 10 条），不出现裸「删除」 */}
        {hasCredential ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClearCredential}>
              删除密钥
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          删除服务商
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 页面级状态卡（加载 / 读取失败 / 真空态共用一套结构，避免三态长得一样）。 */
export function StateCard({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-4 py-10 text-center">
      <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-80 text-xs text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
