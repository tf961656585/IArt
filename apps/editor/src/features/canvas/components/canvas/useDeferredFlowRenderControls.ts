import { useCallback, useRef } from "react";

import type {
  RenderPositionUpdate,
  useFlowRenderState,
} from "./useFlowRenderState";

type FlowRenderStateControls = Pick<
  ReturnType<typeof useFlowRenderState>,
  | "applyRenderPositionUpdates"
  | "beginRenderDragSession"
  | "endRenderDragSession"
>;

export function useDeferredFlowRenderControls() {
  const applyRenderPositionUpdatesRef = useRef<
    (updates: readonly RenderPositionUpdate[]) => void
  >(() => {});
  const beginRenderDragSessionRef = useRef<() => void>(() => {});
  const endRenderDragSessionRef = useRef<() => void>(() => {});

  const applyRenderPositionUpdates = useCallback(
    (updates: readonly RenderPositionUpdate[]) => {
      applyRenderPositionUpdatesRef.current(updates);
    },
    [],
  );
  const beginRenderDragSession = useCallback(() => {
    beginRenderDragSessionRef.current();
  }, []);
  const endRenderDragSession = useCallback(() => {
    endRenderDragSessionRef.current();
  }, []);

  const connectFlowRenderState = useCallback(
    (params: {
      flowRenderState: FlowRenderStateControls;
    }) => {
      applyRenderPositionUpdatesRef.current =
        params.flowRenderState.applyRenderPositionUpdates;
      beginRenderDragSessionRef.current =
        params.flowRenderState.beginRenderDragSession;
      endRenderDragSessionRef.current =
        params.flowRenderState.endRenderDragSession;
    },
    [],
  );

  return {
    applyRenderPositionUpdates,
    beginRenderDragSession,
    endRenderDragSession,
    connectFlowRenderState,
  };
}
