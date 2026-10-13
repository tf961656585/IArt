import type { ChildProcess } from "node:child_process";

type StartupGuardOptions = {
  processName: string;
  reject: (error: Error) => void;
  onProcessExited: () => void;
};

export const attachChildProcessStartupGuard = (
  childProcess: ChildProcess,
  { processName, reject, onProcessExited }: StartupGuardOptions,
) => {
  let startupSettled = false;

  const markStartupSettled = () => {
    startupSettled = true;
  };

  const rejectStartup = (error: Error) => {
    if (startupSettled) return;
    startupSettled = true;
    reject(error);
  };

  childProcess.on("error", (error) => {
    rejectStartup(error instanceof Error ? error : new Error(String(error)));
  });

  childProcess.on("exit", (code, signal) => {
    const wasStartupSettled = startupSettled;
    onProcessExited();
    if (wasStartupSettled) return;
    rejectStartup(
      new Error(
        `${processName} exited before listening (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ),
    );
  });

  return { markStartupSettled };
};
