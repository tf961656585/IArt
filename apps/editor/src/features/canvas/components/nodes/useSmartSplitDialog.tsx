"use client";

import { useCallback, useState } from "react";
import { smartSplitImage } from "@/client/api/imageSmartSplit";
import { createDerivedImageInputNodesFromSmartSplit } from "../../utils/imageDerivation";
import { ensureBackendConsumableImageSource } from "../../utils/mediaUtils";
import { ImageSmartSplitDialog, type ImageSmartSplitDialogPayload } from "../dialogs/ImageSmartSplitDialog";

export function useSmartSplitDialog(
  nodeId: string,
  imageOperationSourceUrl: string | null,
  selectNodes: ((nodeIds: string[], reason: string) => void) | undefined,
) {
  const [open, setOpen] = useState(false);

  const handleConfirm = useCallback(
    async (payload: ImageSmartSplitDialogPayload) => {
      if (!imageOperationSourceUrl) { throw new Error("还没有可用的图片，请先选一张"); }
      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl);
      const result = await smartSplitImage(sourceUrl, {
        alphaThreshold: payload.alphaThreshold,
        minArea: payload.minArea,
        dilateIterations: payload.dilateIterations,
        padding: payload.padding,
      });
      const created = createDerivedImageInputNodesFromSmartSplit({
        sourceNodeId: nodeId,
        alphaThreshold: payload.alphaThreshold,
        minArea: payload.minArea,
        dilateIterations: payload.dilateIterations,
        padding: payload.padding,
        tiles: result.tiles,
        selectNodes,
      });
      if (!created || created.length === 0) { throw new Error("没能生成新的素材节点"); }
    },
    [nodeId, imageOperationSourceUrl, selectNodes],
  );

  const dialog = (
    <ImageSmartSplitDialog
      open={open}
      onOpenChange={setOpen}
      imageUrl={imageOperationSourceUrl}
      onConfirm={handleConfirm}
    />
  );

  const openDialog = useCallback(() => setOpen(true), []);

  return { dialog, openDialog };
}
