import { useEffect, useRef } from 'react';
import { Input, Label, Switch } from '@iart/ui';
import { useRunPolicy } from './RunPolicySection.hooks';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「运行策略」子单元（通用设置分区）：最大并发数（wheel 调整）+ 启动参数开关。
 * 表单变更 debounce 300ms 自动保存，无手动保存/重载按钮；
 * 状态行仅在读取/保存失败时展示（成功静默）。
 *
 * maxBatchTasks 的 wheel 调整必须用原生 addEventListener({ passive: false })：
 * React 合成 onWheel 是被动监听，preventDefault 不生效，滚动页面会同时发生。
 */
export function RunPolicySection() {
  const {
    maxBatchTasks,
    expandInlineParamsOnStartup,
    statusMessage,
    loadSettings,
    handleMaxBatchTasksWheel,
    changeMaxBatchTasks,
    changeExpandInlineParamsOnStartup,
  } = useRunPolicy();

  const maxBatchTasksInputRef = useRef<HTMLInputElement | null>(null);

  // 进入设置 tab 时读取配置（等价 vanilla onSettingsTabActivated → loadSettings(undefined)）
  useEffect(() => {
    void loadSettings(undefined);
  }, [loadSettings]);

  // wheel 调整：原生被动监听（等价 vanilla addEventListener('wheel', ..., { passive: false })）
  useEffect(() => {
    const input = maxBatchTasksInputRef.current;
    if (input === null) return;
    input.addEventListener('wheel', handleMaxBatchTasksWheel, { passive: false });
    return () => {
      input.removeEventListener('wheel', handleMaxBatchTasksWheel);
    };
  }, [handleMaxBatchTasksWheel]);

  return (
    <SettingsSection title="运行策略">
      {/* 纵向字段行 label↔控件 8px（visual-design §8.6 律一） */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="maxBatchTasks">最多同时处理的任务数</Label>
        <Input
          id="maxBatchTasks"
          ref={maxBatchTasksInputRef}
          type="number"
          min={1}
          step={1}
          value={maxBatchTasks}
          onChange={(event) => changeMaxBatchTasks(event.target.value)}
          className="max-w-40"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm">启动时展开节点参数区域</div>
        <Switch
          checked={expandInlineParamsOnStartup}
          onCheckedChange={(checked) => changeExpandInlineParamsOnStartup(checked === true)}
          aria-label="启动时展开节点参数区域"
        />
      </div>

      {statusMessage !== null ? <div className="text-xs text-destructive">{statusMessage}</div> : null}
    </SettingsSection>
  );
}
