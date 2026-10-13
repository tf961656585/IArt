"use client";

import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type CanvasPreparationAction = {
  key: string;
  label: string;
  variant: "primary" | "outline" | undefined;
  onClick: () => void;
  disabled: boolean | undefined;
} | null;

export type CanvasPreparationDiagnostics = {
  phase: string | null | undefined;
  retryPhase: string | null | undefined;
  source: string | null | undefined;
  subsource: string | null | undefined;
  failure: {
    code: string | null | undefined;
    message: string | null | undefined;
  } | null | undefined;
  errorName: string | null | undefined;
  errorCode: string | null | undefined;
  httpStatus: number | null | undefined;
  remoteCode: string | null | undefined;
  remoteMessage: string | null | undefined;
  causeName: string | null | undefined;
  causeMessage: string | null | undefined;
  projectOpenStage: string | null | undefined;
  projectOpenSource: string | null | undefined;
  projectOpenAction: string | null | undefined;
  configKey: string | null | undefined;
  configEndpoint: string | null | undefined;
  timeoutMs: number | null | undefined;
  hint: string | null | undefined;
  syncStatusCode: string | null | undefined;
  syncStatusMessage: string | null | undefined;
  wsEventType: string | null | undefined;
};

export type CanvasPreparationScreenProps = {
  progress: number;
  stageLabel: string;
  title: string;
  description: string;
  detail: string | null | undefined;
  diagnostics: CanvasPreparationDiagnostics | null | undefined;
  warning: string | null | undefined;
  ready: boolean | undefined;
  failed: boolean | undefined;
  actions: CanvasPreparationAction[] | undefined;
};

export function CanvasPreparationScreen({
  progress,
  stageLabel,
  title,
  description,
  detail,
  diagnostics,
  warning,
  ready = false,
  failed = false,
  actions = [],
}: CanvasPreparationScreenProps) {
  const visibleActions = actions.filter(Boolean) as Exclude<
    CanvasPreparationAction,
    null
  >[];
  const StatusIcon = failed
    ? IconAlertTriangle
    : ready
      ? IconCircleCheck
      : IconLoader2;
  const d = diagnostics;
  const diagnosticText =
    d !== null && d !== undefined ? JSON.stringify(d, null, 2) : "";
  const copyDiagnostics = () => {
    if (!diagnosticText || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(diagnosticText);
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.16),_transparent_42%),linear-gradient(180deg,_hsl(var(--background)),_hsl(var(--muted)/0.55))] px-6 py-10">
      <div className="w-full max-w-2xl rounded-3xl border border-border/70 bg-background/92 p-8 shadow-2xl backdrop-blur">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <StatusIcon
              className={!failed && !ready ? "animate-spin" : ""}
              size={24}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
              {stageLabel}
            </p>
            <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            {description}
          </p>
          {detail ? (
            <div className="rounded-2xl border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              {detail}
            </div>
          ) : null}
          {warning ? (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {warning}
            </div>
          ) : null}
          {diagnosticText ? (
            <div className="rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copyDiagnostics}
              >
                复制错误详情
              </Button>
            </div>
          ) : null}
        </div>

        <div className="mt-6 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>准备进度</span>
            <span>{Math.max(0, Math.min(100, Math.round(progress)))}%</span>
          </div>
          <Progress value={progress} aria-label="画布准备进度" />
        </div>

        {visibleActions.length > 0 ? (
          <div className="mt-6 flex flex-wrap gap-3">
            {visibleActions.map((action) => (
              <Button
                key={action.key}
                variant={action.variant ?? "primary"}
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CanvasPreparationScreen;
