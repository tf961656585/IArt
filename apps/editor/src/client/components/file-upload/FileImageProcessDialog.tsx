import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import type { UploadFileItem } from "./fileUploadTypes";

type ProcessDialogProps = {
  open: boolean;
  item: UploadFileItem | null;
  thresholds: [number, number];
  processedSrc: string;
  processingImage: boolean;
  processError: string | null;
  labels: {
    title: string;
    original: string;
    result: string;
    missingSource: string;
    running: string;
    hint: string;
    threshold: string;
    thresholdValue: string;
    cancel: string;
    run: string;
    apply: string;
  };
  onOpenChange: (open: boolean) => void;
  onThresholdsChange: (thresholds: [number, number]) => void;
  onRun: () => void;
  onApply: () => void;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const FileImageProcessDialog: React.FC<ProcessDialogProps> = ({
  open,
  item,
  thresholds,
  processedSrc,
  processingImage,
  processError,
  labels,
  onOpenChange,
  onThresholdsChange,
  onRun,
  onApply,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent form="standard" size="standard">
      <DialogHeader>
        <DialogTitle>{labels.title}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <ProcessPreview
            title={labels.original}
            src={(item !== null && item !== undefined ? item.src : undefined) ?? ""}
            alt={(item !== null && item !== undefined && item.file !== null && item.file !== undefined ? item.file.name : undefined) ?? "original"}
            emptyText={labels.missingSource}
          />
          <ProcessPreview
            title={labels.result}
            src={processedSrc}
            alt={labels.result}
            emptyText={processingImage ? labels.running : labels.hint}
          />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">{labels.threshold}</p>
          <Slider
            value={thresholds as number[]}
            min={0}
            max={255}
            onValueChange={(value) => {
              if (!Array.isArray(value)) return;
              const low = value[0] ?? 0;
              const high = value[1] ?? 0;
              const nextLow = clamp(Math.min(low, high), 0, 254);
              const nextHigh = clamp(Math.max(low, high), nextLow + 1, 255);
              onThresholdsChange([nextLow, nextHigh]);
            }}
          />
          <p className="mt-1 text-sm text-muted-foreground">
            {labels.thresholdValue}
          </p>
          {processError ? (
            <p className="mt-2 text-sm text-destructive">{processError}</p>
          ) : null}
        </div>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(false)}
        >
          {labels.cancel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRun}
          loading={processingImage}
        >
          {labels.run}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onApply}
          disabled={!processedSrc || processingImage}
        >
          {labels.apply}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

function ProcessPreview({
  title,
  src,
  alt,
  emptyText,
}: {
  title: string;
  src: string;
  alt: string;
  emptyText: string;
}) {
  return (
    <div className="flex-1 text-center">
      <p className="mb-2 text-sm font-medium">{title}</p>
      {src ? (
        <Image
          src={src}
          alt={alt}
          width={640}
          height={480}
          unoptimized
          className="mx-auto max-h-80 w-auto rounded object-contain"
        />
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
    </div>
  );
}
