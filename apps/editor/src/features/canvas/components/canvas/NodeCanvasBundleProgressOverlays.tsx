"use client";

import { Button } from "@/components/ui/button";

import { TaskProgressOverlay } from "../TaskProgressOverlay";
import type { useCanvasBundleTransferController } from "./useCanvasBundleTransferController";

type NodeCanvasBundleProgressOverlaysProps = {
  transferController: ReturnType<typeof useCanvasBundleTransferController>;
};

export function NodeCanvasBundleProgressOverlays({
  transferController,
}: NodeCanvasBundleProgressOverlaysProps) {
  const {
    bundleExport,
    bundleImport,
    bundleImportWarningsDialog,
    setBundleImportWarningsDialog,
    exportProgressPercent,
    exportDetailText,
    exportTitle,
    importProgressPercent,
    importDetailText,
    importTitle,
  } = transferController;

  return (
    <>
      <TaskProgressOverlay
        visible={bundleExport.state.visible}
        status={bundleExport.state.status}
        title={exportTitle}
        detailText={exportDetailText}
        progressPercent={exportProgressPercent}
        elapsedMs={bundleExport.state.elapsedMs}
        errorMessage={bundleExport.state.errorMessage}
        onHide={bundleExport.hide}
        onCancel={bundleExport.cancel}
        hideLabel={undefined}
        cancelLabel="取消导出"
        canCancel
        extra={undefined}
      />
      <TaskProgressOverlay
        visible={bundleImport.state.visible}
        status={bundleImport.state.status}
        title={importTitle}
        detailText={importDetailText}
        progressPercent={importProgressPercent}
        elapsedMs={bundleImport.state.elapsedMs}
        errorMessage={bundleImport.state.errorMessage}
        onHide={bundleImport.hide}
        onCancel={bundleImport.cancel}
        hideLabel={undefined}
        cancelLabel="取消导入"
        canCancel
        extra={
          bundleImport.state.status === "success" &&
          bundleImportWarningsDialog.warnings.length > 0 ? (
            <Button
              variant="outline"
              size="2xs"
              onClick={() =>
                setBundleImportWarningsDialog((prev) => ({
                  ...prev,
                  open: true,
                }))
              }
            >
              查看警告
            </Button>
          ) : null
        }
      />
    </>
  );
}
