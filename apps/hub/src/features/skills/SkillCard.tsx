import { Badge, Button, Card, CardContent } from '@iart/ui';
import { Blocks } from 'lucide-react';
import type { SkillCatalogEntry, SkillInstallTargetId, SkillInstalledState } from '@iart/contracts';
import {
  installBusyKey,
  resolveTargetStatus,
  skillHasUpdate,
  type InstallTargetRow,
  type SkillTargetStatus,
} from './SkillsTab.hooks';

export interface SkillCardProps {
  skill: SkillCatalogEntry;
  installedState: SkillInstalledState;
  /** 安装目标行集合（内置 + 自定义，按注册表顺序；useSkills 的 targetRows） */
  targetRows: readonly InstallTargetRow[];
  /** 安装中按钮的忙碌 key 集合（skills hook 的 installing） */
  busyKeys: ReadonlySet<string>;
  /** 全部更新进行中：禁用所有安装按钮 */
  disabled: boolean;
  onInstall: (skill: SkillCatalogEntry, target: SkillInstallTargetId) => void;
  /** 定位该目标的 skill 安装目录（LFJ-007，仅已安装目标呈现，能力门先行） */
  onReveal: (skill: SkillCatalogEntry, target: SkillInstallTargetId) => void;
}

/** 单目标行状态文案（等价 vanilla renderTargetRow 的 statusEl 分支） */
function buildTargetStatusText(status: SkillTargetStatus, skill: SkillCatalogEntry): string {
  if (status.kind === 'not-installed') return '未安装';
  if (status.kind === 'installed') return `已安装 v${status.version}`;
  if (status.kind === 'update-available') return `可以更新到 v${skill.version}`;
  return `已安装 v${status.version}（比商店里的更新）`;
}

/** 单目标行操作按钮（等价 vanilla renderTargetRow 的 btn 分支） */
function buildTargetButton(
  status: SkillTargetStatus,
  busy: boolean,
  disabled: boolean,
  onInstall: () => void,
): { label: string; variant: 'default' | 'outline' | 'ghost'; disabled: boolean; onClick: (() => void) | undefined } {
  if (status.kind === 'not-installed') {
    return { label: '安装', variant: 'outline', disabled: busy || disabled, onClick: onInstall };
  }
  if (status.kind === 'update-available') {
    return { label: '更新', variant: 'default', disabled: busy || disabled, onClick: onInstall };
  }
  return { label: '已安装', variant: 'ghost', disabled: true, onClick: undefined };
}

/** 单个 skill 卡片：图标 + 名称 + 远端版本 + 更新徽章 + 描述 + 安装目标行集合（等价 vanilla renderSkillCard） */
export function SkillCard({ skill, installedState, targetRows, busyKeys, disabled, onInstall, onReveal }: SkillCardProps) {
  const hasUpdate = skillHasUpdate(skill, installedState, targetRows);

  return (
    <Card className="gap-0 p-0 transition hover:bg-elevated hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary p-1.5 text-muted-foreground">
            <Blocks className="h-5 w-5" />
          </div>
          <span className="font-medium">{skill.name}</span>
          <span className="font-mono text-xs text-muted-foreground">v{skill.version}</span>
          {hasUpdate ? (
            <Badge variant="default">
              有更新
            </Badge>
          ) : null}
        </div>
        <div className="font-mono text-xs text-muted-foreground">{skill.id}</div>
        <div className="text-sm text-muted-foreground">{skill.description}</div>
        <div className="flex flex-col gap-1.5">
          {targetRows.map((row) => {
            const status = resolveTargetStatus(skill, row.target, installedState);
            const busy = busyKeys.has(installBusyKey(skill.id, row.target));
            const button = buildTargetButton(status, busy, disabled, () => onInstall(skill, row.target));
            return (
              <div
                key={row.target}
                className="flex items-center justify-between gap-2 rounded-lg bg-elevated px-2 py-1 shadow-sm"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  <span className="shrink-0">{row.label}</span>
                  <span className={status.kind === 'update-available' ? 'text-foreground' : 'text-muted-foreground'}>
                    {buildTargetStatusText(status, skill)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {status.kind !== 'not-installed' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`打开 ${row.label} 的安装文件夹`}
                      onClick={() => onReveal(skill, row.target)}
                    >
                      打开所在文件夹
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={button.variant}
                    disabled={button.disabled}
                    aria-label={busy ? `正在安装到 ${row.label}` : `${button.label}（${row.label}）`}
                    onClick={button.onClick}
                  >
                    {busy ? '正在安装…' : button.label}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
