export function normalizeSelectionIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function normalizeSelectionContractFields(fields: {
  nodeIds: string[];
  annotationIds: string[];
}): {
  nodeIds: string[];
  annotationIds: string[];
} {
  return {
    nodeIds: normalizeSelectionIds(fields.nodeIds),
    annotationIds: normalizeSelectionIds(fields.annotationIds),
  };
}
