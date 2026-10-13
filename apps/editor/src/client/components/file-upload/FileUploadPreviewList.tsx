import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip-button";
import type {
  FileUploadPreviewLayout,
  UploadFileItem,
} from "./fileUploadTypes";

type PreviewListProps = {
  items: UploadFileItem[];
  allowMultiple: boolean;
  compactPreviewActive: boolean;
  previewLayout: FileUploadPreviewLayout;
  previewContainerClassName: string;
  previewContainerStyle: React.CSSProperties | undefined | undefined;
  previewCardStyle: React.CSSProperties | undefined | undefined;
  previewImageStyle: React.CSSProperties | undefined | undefined;
  isImagePreview: (item: UploadFileItem) => boolean;
  fallbackName: string;
  labels: {
    moveLeft: string;
    moveRight: string;
    process: string;
    preview: string;
    remove: string;
  };
  onMove: (fromIndex: number, toIndex: number) => void;
  onOpenEditor: (index: number) => void;
  onPreview: (item: UploadFileItem) => void;
  onRemove: (index: number) => void;
};

const tooltipWrapperStyle: React.CSSProperties = { display: "inline-flex" };

const resolveGridColumns = (count: number): "1" | "2" | "3" =>
  count <= 1 ? "1" : count === 2 ? "2" : "3";

export const FileUploadPreviewList: React.FC<PreviewListProps> = ({
  items,
  allowMultiple,
  compactPreviewActive,
  previewLayout,
  previewContainerClassName,
  previewContainerStyle,
  previewCardStyle,
  previewImageStyle,
  isImagePreview,
  fallbackName,
  labels,
  onMove,
  onOpenEditor,
  onPreview,
  onRemove,
}) => {
  const inspectorGridActive = previewLayout === "inspectorGrid";
  const gridColumns = resolveGridColumns(items.length);
  const listClassName = inspectorGridActive
    ? "grid gap-1.5"
    : "flex flex-wrap gap-2";
  const listStyle = inspectorGridActive
    ? {
        gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
      }
    : undefined;

  return (
    <div
      data-testid="file-upload-preview-container"
      data-compact-active={compactPreviewActive ? "true" : "false"}
      data-preview-layout={previewLayout}
      data-grid-columns={inspectorGridActive ? gridColumns : undefined}
      className={previewContainerClassName}
      style={previewContainerStyle}
    >
      <div className={listClassName} style={listStyle}>
        {items.map((it, idx) => (
          <div
            key={it.id ?? `${idx}`}
            className={
              inspectorGridActive
                ? "relative aspect-square overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring"
                : `bg-background rounded border p-2 flex flex-col items-center gap-1 ${compactPreviewActive ? "" : "w-40"}`
            }
            style={inspectorGridActive ? undefined : previewCardStyle}
          >
            <PreviewMedia
              item={it}
              compactPreviewActive={compactPreviewActive}
              inspectorGridActive={inspectorGridActive}
              previewImageStyle={previewImageStyle}
              isImagePreview={isImagePreview}
              fallbackName={fallbackName}
            />
            <div
              data-testid={inspectorGridActive ? "file-upload-preview-actions" : undefined}
              className={
                inspectorGridActive
                  ? "absolute inset-0 grid grid-cols-2 content-center justify-items-center gap-0.5 bg-background/70 p-0.5 opacity-100"
                  : "flex flex-wrap justify-center gap-2"
              }
            >
              {allowMultiple && items.length > 1 ? (
                <>
                  <PreviewAction
                    label={labels.moveLeft}
                    icon={<ArrowLeft className="size-4" />}
                    inspectorGridActive={inspectorGridActive}
                    variant="outline"
                    onClick={() => onMove(idx, idx - 1)}
                    disabled={idx === 0}
                  />
                  <PreviewAction
                    label={labels.moveRight}
                    icon={<ArrowRight className="size-4" />}
                    inspectorGridActive={inspectorGridActive}
                    variant="outline"
                    onClick={() => onMove(idx, idx + 1)}
                    disabled={idx === items.length - 1}
                  />
                </>
              ) : null}
              {isImagePreview(it) ? (
                <PreviewAction
                  label={labels.process}
                  icon={<SlidersHorizontal className="size-4" />}
                  inspectorGridActive={inspectorGridActive}
                  variant="ghost"
                  onClick={() => onOpenEditor(idx)}
                />
              ) : null}
              <PreviewAction
                label={labels.preview}
                icon={<Eye className="size-4" />}
                inspectorGridActive={inspectorGridActive}
                variant="ghost"
                onClick={() => onPreview(it)}
              />
              <PreviewAction
                label={labels.remove}
                icon={<Trash2 className="size-4" />}
                inspectorGridActive={inspectorGridActive}
                variant={inspectorGridActive ? "ghost" : "destructive"}
                destructiveHover={inspectorGridActive}
                onClick={() => onRemove(idx)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

function PreviewMedia({
  item,
  compactPreviewActive,
  inspectorGridActive,
  previewImageStyle,
  isImagePreview,
  fallbackName,
}: {
  item: UploadFileItem;
  compactPreviewActive: boolean;
  inspectorGridActive: boolean;
  previewImageStyle: React.CSSProperties | undefined | undefined;
  isImagePreview: (item: UploadFileItem) => boolean;
  fallbackName: string;
}) {
  if (isImagePreview(item)) {
    return (
      <Image
        src={item.src ?? ""}
        alt={(item.file !== null && item.file !== undefined ? item.file.name : undefined) ?? "file"}
        width={160}
        height={96}
        unoptimized
        className={
          inspectorGridActive
            ? "h-full w-full object-cover"
            : `w-full rounded object-cover ${compactPreviewActive ? "" : "h-24"}`
        }
        style={inspectorGridActive ? undefined : previewImageStyle}
      />
    );
  }
  const text = item.src ?? (item.file !== null && item.file !== undefined ? item.file.name : undefined) ?? fallbackName;
  return (
    <div
      className={
        inspectorGridActive
          ? "flex h-full items-center justify-center p-2 text-center text-[10px] leading-tight text-muted-foreground break-all"
          : "text-center text-xs break-all"
      }
    >
      {text}
    </div>
  );
}

function PreviewAction({
  label,
  icon,
  inspectorGridActive,
  variant,
  destructiveHover,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  inspectorGridActive: boolean;
  variant: "outline" | "ghost" | "destructive";
} & Partial<{
  destructiveHover: boolean | undefined;
  disabled: boolean | undefined;
}> & {
  onClick: () => void;
}) {
  return (
    <TooltipButton
      triggerWrapperStyle={tooltipWrapperStyle}
      tooltip={label}
      type="button"
      variant={variant}
      size="icon-sm"
      className={
        inspectorGridActive
          ? `size-6 bg-background/90 shadow-sm ${destructiveHover ? "hover:bg-destructive hover:text-destructive-foreground" : ""}`
          : "transition-transform hover:-translate-y-px"
      }
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {icon}
    </TooltipButton>
  );
}
