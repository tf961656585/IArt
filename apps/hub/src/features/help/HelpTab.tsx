import { Button, Card, CardContent, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@iart/ui';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useHubStore } from '../../client/store/hub-store';
import { requestFirstRunGuideReplay } from '../onboarding';
import { HubTopBand } from '../../components/HubTopBand';

const QUICK_LINKS: { tab: string; label: string }[] = [
  { tab: 'canvas', label: '画布' },
  { tab: 'prompt-preset', label: '提示词预设' },
  { tab: 'task-monitor', label: '任务监控' },
  { tab: 'settings', label: '设置' },
];

const FAQ_ITEMS: { question: string; answer: string }[] = [
  { question: '怎么切换要用的模型？', answer: '打开项目后，在生成入口的模型列表里选择。软件里的模型随软件更新提供；要添加其他模型，可在设置页的服务商详情里点「添加模型」：软件自带的直接勾选，软件没有的自己定义。' },
  { question: '生成记录在哪里看？', answer: '在「任务监控」里选择项目，就能看到这个项目的全部生成任务和进展。' },
];

export function HelpTab() {
  const setCurrentTab = useHubStore((s) => s.setCurrentTab);

  return (
    <div className="flex h-full w-full flex-col">
      {/* 内容列自带滚动（与其他 tab 同构）：外层 main 已收为裁剪容器，
          此页不再依赖外层滚动，缺内滚会把长内容截断在视口外 */}
      <HubTopBand>
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold text-foreground">帮助中心</h1>
          <span className="text-sm text-muted-foreground">浏览常见问题、快速入口与联系支持的方式。</span>
        </div>
      </HubTopBand>
      <div className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="gap-0 p-0">
            <CardContent className="flex flex-col gap-3 p-4">
              <h2 className="text-lg font-medium text-foreground">快速入口</h2>
              <ul className="space-y-2">
                {QUICK_LINKS.map((link) => (
                  <li key={link.tab}>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => setCurrentTab(link.tab)}
                    >
                      {link.label}
                      <ExternalLink />
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">若找不到答案，请通过下方联系方式与我们团队取得联系。</p>
            </CardContent>
          </Card>

          <Card className="gap-0 p-0">
            <CardContent className="flex flex-col gap-3 p-4">
              <h2 className="text-lg font-medium text-foreground">常见问题</h2>
              <div className="space-y-3">
                {/* FAQ 手风琴（复合控件，按钮样式标准 §7 出路①）：折叠头是 Collapsible 的组成件，
                    视觉语义由手风琴控件整体承载，不走共享 Button */}
                <Collapsible className="group">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      怎么添加服务商和模型？
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="pt-2 text-sm text-muted-foreground">
                      到「设置 → 服务商与模型」添加一个服务商（服务地址、密钥），再在它的详情里「添加模型」。
                    </p>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 pt-2"
                      onClick={() => requestFirstRunGuideReplay()}
                    >
                      重新查看首次指引
                    </Button>
                  </CollapsibleContent>
                </Collapsible>
                {FAQ_ITEMS.map((item) => (
                  <Collapsible key={item.question} className="group">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.question}
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="pt-2 text-sm text-muted-foreground">{item.answer}</p>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="gap-0 p-0 md:col-span-2">
            <CardContent className="flex flex-col gap-3 p-4">
              <h2 className="text-lg font-medium text-foreground">支持与联系</h2>
              <ul className="space-y-2 text-sm text-foreground">
                <li>
                  <span className="font-bold">邮箱：</span>
                  <span className="font-mono">961656585@qq.com</span>
                </li>
                <li>
                  <span className="font-bold">微信：</span>
                  <span className="font-mono">Tian_Riching</span>
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">工作日 9:00-18:00（北京时间）提供人工支持。</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
