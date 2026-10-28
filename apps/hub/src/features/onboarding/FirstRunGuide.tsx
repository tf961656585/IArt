import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogTitle } from '@iart/ui';
import { Aperture } from 'lucide-react';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { useHubStore } from '../../client/store/hub-store';

/**
 * 首次指引欢迎面（docs/hub/首次指引-design.md §3/§4，2026-09-24 拍板方案 A）。
 *
 * 触发判定（§4.2）：零服务商 && 未看过指引 && 判定请求全部成功。
 * - 配置状态消费既有事实源（GET /api/provider-connections），不自建第二套判定（IA §9.1）；
 *   任一请求失败不显示（宁缺勿误，对齐 unknown 不误报口径）。
 * - 2026-10-19 起判据由「零服务商且零模型」改为「零服务商」：模型必须归属某条服务商连接
 *   （没有连接就不可能有模型），第二个条件恒真、只是把一次请求白算进触发判定；而部署载体
 *   退场后「零模型」也没有独立数据源可查了。
 * - 「已看过」记忆走 GET/PUT /api/onboarding-state（config/onboarding-state.json，
 *   独立小文件）；点「以后再说」/关闭写标记，本会话立即消失、之后启动不再出现。
 * - 帮助中心「重新查看首次指引」走 replayRequest 通道：仅当次重开，不反转已看标记。
 *
 * IA §9.3 修订（豁免条款）随实现批次落 spec：一次性、可跳过、配置后永久消失，
 * 与被禁止的常驻预告不同。
 */

interface GuideStepsData {
  readonly title: string;
  readonly desc: string;
}

const GUIDE_STEPS: readonly GuideStepsData[] = [
  {
    title: '添加服务商',
    desc: '到「设置 → 服务商与模型」，点「添加服务商」，填上服务地址和密钥。',
  },
  {
    title: '添加模型',
    desc: '在这个服务商的详情里点「添加模型」，填上模型 ID 和接口格式就行。',
  },
  {
    title: '回画布创作',
    desc: '打开项目，在底部创作条选好模型，就能开始生成了。',
  }
];

/** 「服务商与模型 · 服务商」锚点 id（SettingsNav.tsx SETTINGS_NAV_GROUPS 唯一定义；深链 hash 消费同名值）。 */
const PROVIDERS_SECTION_ID = 'providers';

/** 模块级重放信号：帮助中心触发时置入，FirstRunGuide 挂载期间轮询消费。 */
let replaySignal = false;

/** 帮助中心入口调用：仅当次重开欢迎面（不清除已看标记）。 */
export const requestFirstRunGuideReplay = (): void => {
  replaySignal = true;
};

export function FirstRunGuide() {
  const { api } = useHubRuntime();
  const setCurrentTab = useHubStore((s) => s.setCurrentTab);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const evaluate = async (): Promise<void> => {
      // 两路并行：配置状态一条既有端点 + 已看标记。
      const [connectionsResult, onboardingResult] = await Promise.allSettled([
        api.listProviderConnections(controller.signal),
        api.getOnboardingState(controller.signal),
      ]);
      if (cancelled) return;
      // 任一判定信号不可得 → 不显示（宁缺勿误；对齐「unknown 不误报未就绪」口径）。
      if (connectionsResult.status !== 'fulfilled' || onboardingResult.status !== 'fulfilled') {
        return;
      }
      const noConnections = connectionsResult.value.connections.length === 0;
      const notDismissed = onboardingResult.value.state.guideDismissed === false;
      if (noConnections && notDismissed) {
        setOpen(true);
      }
    };

    void evaluate();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api]);

  // 帮助中心重放：挂载期间轮询信号（replay 不清除已看标记，仅当次打开）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (replaySignal) {
        replaySignal = false;
        setOpen(true);
      }
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const dismiss = useCallback((): void => {
    setOpen(false);
    // 写已看标记失败静默（下次启动会再弹一次，代价可接受；不留第二套失败通道）。
    void api.dismissOnboardingGuide();
  }, [api]);

  const goSettings = useCallback((): void => {
    setOpen(false);
    void api.dismissOnboardingGuide();
    setCurrentTab('settings');
    // 锚点定位经 hash 深链（SettingsTab 挂载时读取）：providers = 「服务商与模型 · 服务商」。
    window.history.replaceState(null, '', `#${PROVIDERS_SECTION_ID}`);
  }, [api, setCurrentTab]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        form="standard"
        size="compact"
        className="gap-0 p-0"
        aria-describedby={undefined}
      >
        <div className="flex flex-col gap-4 p-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/15">
            <Aperture className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <DialogTitle className="text-xl font-semibold tracking-tight">欢迎使用 IARTStudio</DialogTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            三步就能开始生成。
          </p>
          <ol className="flex flex-col gap-2.5">
            {GUIDE_STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3 rounded-lg border border-border bg-card p-3">
                <span
                  className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{step.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{step.desc}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-1 flex items-center gap-2.5">
            <Button type="button" onClick={goSettings}>去添加服务商</Button>
            <Button type="button" variant="ghost" onClick={dismiss}>以后再说</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
