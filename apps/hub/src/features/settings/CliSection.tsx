import { Button } from '@iart/ui';
import type { CliCommandLogEntry } from '@iart/contracts';
import {
  commandStatusText,
  entryGuidanceLines,
  entryStateText,
  formatCommandDuration,
  useCliSection,
} from './CliSection.hooks';
import { formatTime } from '../../client/utils/time';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「命令行工具」子单元（通用设置分区，spec docs/integrations/CLI与本地Agent集成.md §8）：
 * 只读状态展示（CLI 通道在役状态、发现文件有效性、命令入口注册状态五态、最近命令记录）
 * + 命令入口一键注册/卸除注册（幂等，CLI-016）。
 * 只读展示，不承载 CLI 行为配置，不提供令牌查看或重置（CLI-013）；
 * 端口、发现文件路径等诊断细节不进界面。动作结果在子单元内显示（Hub 无 toast）。
 */
export function CliSection() {
  const { status, loading, loadFailed, pending, notice, refresh, register, unregister } = useCliSection();

  return (
    <SettingsSection
      title="命令行工具"
      action={
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          刷新
        </Button>
      }
    >
      {status === null ? (
        loading ? (
          <div className="text-xs text-muted-foreground">正在读取状态...</div>
        ) : loadFailed ? (
          <div className="text-xs text-destructive">没能读取命令行工具状态，请重试</div>
        ) : null
      ) : (
        <>
          {/* 状态行（§8.2 行式布局：label 左、值/控件右；字段行 trailing 对齐不适用拉空上限） */}
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground">运行状态</span>
              <span>{status.serviceRunning ? '运行中' : '未运行'}</span>
              {/* 发现文件有效性按次级信息并入在役状态行（spec §8）；正常（有效）时不印，避免噪音 */}
              {status.discoveryFileValid ? null : (
                <span className="min-w-0 text-xs text-muted-foreground">重启应用前，终端的 iart 命令可能连不上</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">终端命令</span>
                <span>{entryStateText(status.entry)}</span>
                {/* 落点入口路径随状态印出（失效/他物态需要它定位现场）；未注册不印未来落点，避免噪音 */}
                {status.entry.entryPath !== null && status.entry.state !== 'missing' ? (
                  <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                    {status.entry.entryPath}
                  </span>
                ) : null}
              </div>
              {/* unsupported = 平台不支持一键注册，不渲染动作。
                  注册/卸除是正反向动作对（§4）：同尺寸 sm；卸除是行内危险动作 → ghost-destructive；
                  失效/他物态按钮同为注册动作（重新注册即幂等覆盖）；忙碌态由 loading prop 承载
                  （spinner + aria-busy + 自动禁用），不改写文案 */}
              {status.entry.state === 'missing' || status.entry.state === 'stale' || status.entry.state === 'foreign' ? (
                <Button size="sm" loading={pending === 'register'} disabled={pending !== null} onClick={() => void register()}>
                  注册 iart 命令
                </Button>
              ) : status.entry.state === 'registered' ? (
                <Button size="sm" variant="ghost-destructive" loading={pending === 'unregister'} disabled={pending !== null} onClick={() => void unregister()}>
                  卸除注册
                </Button>
              ) : null}
            </div>
            {/* 五态说明 / 旧入口遮蔽 / PATH 引导（spec §8）：正常态不印，避免噪音 */}
            {entryGuidanceLines(status.entry).map((line) => (
              <div key={line} className="text-xs text-muted-foreground">
                {line}
              </div>
            ))}
          </div>

          {notice !== null ? (
            <div className={notice.kind === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {notice.text}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">最近命令</div>
            {status.recentCommands.length === 0 ? (
              <div className="text-xs text-muted-foreground">暂无命令记录</div>
            ) : (
              <div className="flex flex-col gap-2">
                {status.recentCommands.map((entry, index) => (
                  <CommandLogRow key={index} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/** 命令记录行（紧凑两行制：命令名 + 参数摘要一行，状态 + 时间 + 耗时一行；§8.6 律二呼吸档） */
function CommandLogRow({ entry }: { entry: CliCommandLogEntry }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-elevated px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs">{entry.command}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entry.paramsSummary}</span>
      </div>
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span className={entry.status === 'error' ? 'text-destructive' : undefined}>{commandStatusText(entry)}</span>
        <span className="font-mono">{formatTime(entry.timestamp)}</span>
        <span>{formatCommandDuration(entry.durationMs)}</span>
      </div>
    </div>
  );
}
