import { isAnnotationBinding, type AnnotationBinding, type NodeGraph } from "../../types";

export const isAnnotationBound = (
  binding: AnnotationBinding | null | undefined,
): boolean => isAnnotationBinding(binding) && binding.type !== "free";

export const findAnnotationIdForContextMenuTarget = (
  nodeGraph: NodeGraph | null | undefined,
  id: string,
): string | null => {
  const annotations = (nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.annotations : undefined) ?? [];
  for (const annotation of annotations) {
    const binding = (annotation !== null && annotation !== undefined ? annotation.binding : undefined);
    if (!isAnnotationBinding(binding)) continue;
    if (binding.type === "node" && binding.nodeId === id) {
      return annotation.id;
    }
  }
  return null;
};
