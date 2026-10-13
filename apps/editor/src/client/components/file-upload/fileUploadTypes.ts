import type {
  ImageResizeMode,
  ImageValidationConstraints,
} from "@iart/contracts/media/imageValidationTypes";

export type UploadFileItem = {
  id: string | undefined;
  file: File | undefined;
  src: string | undefined;
  dimensions: { width: number; height: number } | undefined;
};

export type ProcessedFileItem = {
  id: string;
  file: File;
  src: string;
  dimensions: { width: number; height: number } | undefined;
};

export type FileUploadPreviewLayout = "card" | "inspectorGrid";

export type FileUploadCompactPreviewConfig = Partial<{
  enabled: boolean | undefined;
  activateAtCount: number | undefined;
  maxHeightPx: number | undefined;
  cardWidthPx: number | undefined;
  imageHeightPx: number | undefined;
}>;

type FileUploadDefaultedProps = Partial<{
  accept: string | undefined;
  multiple: boolean | undefined;
  maxSizeMB: number | undefined;
  maxDimension: number | undefined;
  imageResizeMode: ImageResizeMode | undefined;
  imageConstraints: ImageValidationConstraints | undefined;
  showHints: boolean | undefined;
  compactPreview: boolean | FileUploadCompactPreviewConfig | undefined;
  previewMode: "default" | "hidden" | undefined;
  previewLayout: FileUploadPreviewLayout | undefined;
  onLimitExceeded: (maxFiles: number) => void | undefined;
  autoUpload: boolean | undefined;
  uploadMockLatency: number | undefined;
}>;

export type FileUploadProps = {
  value: UploadFileItem[] | undefined;
  onFilesChange: (files: UploadFileItem[]) => void;
  maxFiles: number;
} & FileUploadDefaultedProps;

export type FilePreviewTitleResolver = (item: UploadFileItem) => string;

export type ValidationMessage = { type: "info" | "error"; text: string };
