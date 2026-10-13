"use client";

import type { ErrorInfo, ReactNode } from "react";
import React from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardIcon,
  RotateCcwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { logCanvasDebugSnapshot } from "@/features/canvas/debug/canvasDebug";
import {
  buildDiagnosticText,
  getUserFacingErrorMessage,
} from "./diagnosticErrorBoundaryShared";

type DiagnosticErrorBoundaryProps = {
  children: ReactNode;
} & Partial<{
  label: string | undefined;
}>;

type DiagnosticErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
};

const readLastUnhandledError = (): unknown => {
  if (typeof window === "undefined") return null;
  const diagnosticWindow = window as typeof window & {
    __IART_LAST_UNHANDLED_ERROR__: unknown | undefined;
  };
  return diagnosticWindow.__IART_LAST_UNHANDLED_ERROR__ ?? null;
};

export class DiagnosticErrorBoundary extends React.Component<
  DiagnosticErrorBoundaryProps,
  DiagnosticErrorBoundaryState
> {
  state: DiagnosticErrorBoundaryState = {
    error: null,
    componentStack: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): DiagnosticErrorBoundaryState {
    return { error, componentStack: null, copied: false };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
    logCanvasDebugSnapshot(
      this.props.label ? `ErrorBoundary(${this.props.label})` : "ErrorBoundary",
      error,
    );
  }

  private copyDiagnostic = async (text: string): Promise<void> => {
    try {
      if (typeof navigator !== "undefined" && (navigator.clipboard !== null && navigator.clipboard !== undefined ? navigator.clipboard.writeText : undefined)) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1600);
    } catch {
      this.setState({ copied: false });
    }
  };

  private reloadEditor = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    const { error, componentStack, copied } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-background p-6 text-sm">
        <div className="w-full max-w-lg rounded-md border bg-card p-6 shadow-xs">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <AlertTriangleIcon className="size-4 text-destructive" />
            编辑器遇到了问题
          </div>
          <p className="mt-3 whitespace-pre-wrap break-words leading-6 text-muted-foreground">
            {getUserFacingErrorMessage(error)}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={this.reloadEditor}
            >
              <RotateCcwIcon className="size-4" />
              重新加载编辑器
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void this.copyDiagnostic(
                  buildDiagnosticText({
                    error,
                    componentStack,
                    lastUnhandledError: readLastUnhandledError(),
                  }),
                )
              }
            >
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <ClipboardIcon className="size-4" />
              )}
              {copied ? "已复制" : "复制错误详情"}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export default DiagnosticErrorBoundary;
