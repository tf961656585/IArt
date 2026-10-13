export interface SchemaImageSizeOption {
  value: number;
  labelKey: string | undefined;
  label: string | undefined;
}

export interface SchemaImageSizeAspectOption {
  id: string | undefined;
  value: string | undefined;
  ratio: number | undefined;
  labelKey: string | undefined;
  label: string | undefined;
  descriptionKey: string | undefined;
  description: string | undefined;
  resolution: { width: number; height: number } | undefined;
}

export interface SchemaImageSizePresetOption {
  value: string;
  labelKey: string | undefined;
  label: string | undefined;
  descriptionKey: string | undefined;
  description: string | undefined;
}

export interface SchemaImageSizeLevelOption {
  id: string;
  labelKey: string | undefined;
  label: string | undefined;
  /** 级别语义：总像素预算（如 1K = 1024² = 1048576），不再是长边像素 */
  pixelBudget: number;
}

export interface SchemaImageSizeConstrainedAspectPreset {
  id: string;
  labelKey: string | undefined;
  label: string | undefined;
  ratio: number;
}

export interface SchemaImageSizeConstrainedResolutionConstraints {
  dimensionMultiple: number;
  maxLongEdge: number;
  minPixels: number;
  maxPixels: number;
  maxAspectRatio: number;
}
