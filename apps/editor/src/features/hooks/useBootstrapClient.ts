"use client";

import { useEffect } from "react";
import { initModelStore, useModelStore } from "@/client/store/modelStore";
import { useRuntimeStore } from "@/client/store/runtimeStore";
import {
  initAutoDiscovery,
  setRuntimeProjectedModels,
} from "@/client/config/models.config";
import { fetchModelAssetNodeProjections } from "@/client/api/modelAssetProjections";
import { buildModelConfigsFromNodeProjections } from "@/client/config/modelAssetProjectionBridge";
import {
  fetchEditorBootstrapFromElectron,
  fetchRuntimeFlagsFromElectron,
  isElectronEnvironment,
} from "@/client/utils/electronBridge";
import { hasLocalHubBaseHint } from "@/client/utils/apiConfig";
import { reportDesktopE2EEvent } from "@/client/utils/desktopE2E";
import { setRuntimeFlags } from "@/client/utils/runtimeFlags";
import {
  registerModelAssetLocalizationBundles,
  setClientLanguage,
} from "@/lib/i18n/client";

let initialized = false;

export const resetBootstrapClientForTests = (): void => {
  initialized = false;
};

const installFetchAudit = () => {
  if (typeof window === "undefined") {
    return;
  }
  const guardKey = "__IART_FETCH_AUDIT__";
  const auditInstalled: unknown = Reflect.get(window, guardKey);
  if (auditInstalled === true) {
    return;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit | undefined) => {
    try {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof (input as Request).url === "string"
              ? (input as Request).url
              : "";
      const trimmed = rawUrl.trim();
      const isRelative = trimmed.startsWith("/");
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        if (host !== "localhost" && host !== "127.0.0.1") {
          console.warn("[fetch-audit] Hub 模式下检测到直连远程请求", trimmed);
        }
      } else if (isRelative && trimmed.startsWith("/api/")) {
        console.warn("[fetch-audit] Hub 模式下检测到本地 API 直连", trimmed);
      }
    } catch {
      // ignore
    }
    return originalFetch(input, init);
  };
  Reflect.set(window, guardKey, true);
};

const getBootstrapUserMessage = (error: unknown): string => {
  if (
    error instanceof Error &&
    error.message === "Desktop Shell 未提供有效的 editor bootstrap"
  ) {
    return "项目打开失败，请重新打开项目。";
  }
  return "项目打开失败，请重新打开项目。";
};

const useBootstrapClient = () => {
  useEffect(() => {
    if (initialized) {
      return;
    }
    initialized = true;
    const runtimeState = useRuntimeStore.getState();

    const bootstrap = async () => {
      const __t0 = Date.now();
      let __step = "init";
      try {
        console.info("[editor:bootstrap] start");
        runtimeState.setBootstrapLoading();
        __step = "runtime-flags";
        const runtimeFlags = await fetchRuntimeFlagsFromElectron();
        console.info("[editor:bootstrap] runtime flags fetched", {
          isPackaged: (runtimeFlags !== null && runtimeFlags !== undefined ? runtimeFlags.isPackaged : undefined),
        });

        const electronDev =
          isElectronEnvironment() && (runtimeFlags !== null && runtimeFlags !== undefined ? runtimeFlags.isPackaged : undefined) === false;
        setRuntimeFlags({ electronDev });

        if (isElectronEnvironment()) {
          __step = "desktop-bootstrap";
          const __bs0 = Date.now();
          console.info("[editor:bootstrap] fetch desktop bootstrap start");
          const desktopBootstrap = await fetchEditorBootstrapFromElectron();
          console.info("[editor:bootstrap] fetch desktop bootstrap end", {
            elapsed: Date.now() - __bs0,
            hasResult: !!desktopBootstrap,
          });
          if (!desktopBootstrap) {
            console.error("[editor:bootstrap] desktop bootstrap is null");
            throw new Error("Desktop Shell 未提供有效的 editor bootstrap");
          }
          useRuntimeStore.getState().setDesktopBootstrap(desktopBootstrap);
          console.info("[editor:bootstrap] bootstrap applied", {
            projectPath: desktopBootstrap.projectPath,
            backendBaseUrl: desktopBootstrap.backendBaseUrl,
          });
          await reportDesktopE2EEvent("renderer-bootstrap-ready", {
            backendBaseUrl: desktopBootstrap.backendBaseUrl,
            projectPath: desktopBootstrap.projectPath,
            sessionToken: desktopBootstrap.sessionToken,
          });
          await setClientLanguage(desktopBootstrap.locale);
        }

        if (hasLocalHubBaseHint()) {
          installFetchAudit();
        }
        __step = "auto-discovery";
        const __ad0 = Date.now();
        await initAutoDiscovery();
        console.info("[editor:bootstrap] auto discovery done", {
          elapsed: Date.now() - __ad0,
        });
        __step = "projections";
        const __pr0 = Date.now();
        const projectionPayload = await fetchModelAssetNodeProjections();
        if (projectionPayload && Array.isArray(projectionPayload.projections)) {
          registerModelAssetLocalizationBundles(
            projectionPayload.localization_bundles,
          );
          const runtimeConfigs = buildModelConfigsFromNodeProjections(
            projectionPayload.projections,
          );
          setRuntimeProjectedModels(runtimeConfigs);
          console.info("[editor:bootstrap] projections loaded", {
            count: projectionPayload.projections.length,
            mapped: runtimeConfigs.length,
            elapsed: Date.now() - __pr0,
          });
          const droppedCount =
            projectionPayload.projections.length - runtimeConfigs.length;
          if (droppedCount > 0) {
            console.warn(
              "[model-asset] runtime projection mapping dropped entries",
              {
                total: projectionPayload.projections.length,
                mapped: runtimeConfigs.length,
                dropped: droppedCount,
              },
            );
          }
          if (
            Array.isArray(projectionPayload.diagnostics) &&
            projectionPayload.diagnostics.length > 0
          ) {
            console.warn(
              "[model-asset] projection diagnostics",
              projectionPayload.diagnostics,
            );
          }
        } else {
          console.warn(
            "[model-asset] node projections unavailable, runtime remote models remain empty",
          );
          setRuntimeProjectedModels([]);
        }
        __step = "model-store";
        if (useModelStore.getState().models.length === 0) {
          const __ms0 = Date.now();
          await initModelStore();
          console.info("[editor:bootstrap] model store initialized", {
            modelCount: useModelStore.getState().models.length,
            elapsed: Date.now() - __ms0,
          });
        }

        console.info("[editor:bootstrap] complete", {
          totalElapsed: Date.now() - __t0,
        });
      } catch (error) {
        console.error("[editor:bootstrap] failed", {
          step: __step,
          error,
          totalElapsed: Date.now() - __t0,
        });
        if (isElectronEnvironment()) {
          await reportDesktopE2EEvent("renderer-bootstrap-error", {
            message:
              error instanceof Error
                ? error.message
                : "editor_bootstrap_failed",
          });
        }
        useRuntimeStore
          .getState()
          .setBootstrapError(getBootstrapUserMessage(error));
      }
    };

    void bootstrap();
  }, []);
};

export default useBootstrapClient;
