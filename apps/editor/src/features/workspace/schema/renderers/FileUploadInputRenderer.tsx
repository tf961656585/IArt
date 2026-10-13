import React from "react";
import { ImagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileUpload, type UploadFileItem } from "@/client/components/FileUpload";
import { FieldLabel } from "@/features/workspace/schema/components/FieldLabel";
import { resolveUploadMaxFiles } from "@/features/workspace/schema/helpers";
import type {
  SchemaFileField,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaImageUploadField,
  SchemaTranslate,
} from "@/features/workspace/schema/types";

type UploadSchemaField<FieldKey extends string> =
  | SchemaFileField<FieldKey>
  | SchemaImageUploadField<FieldKey>;

type UploadFieldMetadata = {
  compactUpload: unknown | undefined;
};

interface FileUploadInputProps<FieldKey extends string> {
  field: UploadSchemaField<FieldKey>;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  disabled: boolean;
  label: string;
  helperText: string;
  displayErrorText: string | null;
  translate: SchemaTranslate;
  onChange: (value: unknown) => void;
  useIconLabels: boolean | undefined;
}

export const FileUploadInput = <FieldKey extends string>({
  field,
  values,
  modelId,
  disabled,
  label,
  helperText,
  displayErrorText,
  translate,
  onChange,
  useIconLabels,
}: FileUploadInputProps<FieldKey>) => {
  const [open, setOpen] = React.useState(false);
  const iconLabels = Boolean(useIconLabels);
  const value = values[field.key];
  const items = Array.isArray(value) ? (value as UploadFileItem[]) : [];
  const maxFiles = resolveUploadMaxFiles(field, values, modelId);
  const accept = field.type === "imageUpload" ? field.accept ?? "image/*" : field.accept;
  const compact = Boolean((field.metadata !== null && field.metadata !== undefined ? (field.metadata as UploadFieldMetadata).compactUpload : undefined));

  const upload = (
    <FileUpload
      value={items}
      onFilesChange={(next) => onChange(next)}
      {...(accept !== undefined ? { accept } : {})}
      {...(field.maxSizeMB !== undefined ? { maxSizeMB: field.maxSizeMB } : {})}
      {...(field.type === "imageUpload" && field.maxDimension !== undefined
        ? { maxDimension: field.maxDimension }
        : {})}
      {...(field.type === "imageUpload" && field.imageResizeMode !== undefined
        ? { imageResizeMode: field.imageResizeMode }
        : {})}
      {...(field.type === "imageUpload" && field.imageConstraints !== undefined
        ? { imageConstraints: field.imageConstraints }
        : {})}
      maxFiles={maxFiles}
      multiple={maxFiles > 1}
    />
  );

  if (compact) {
    return (
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <button
                type="button"
                aria-label={label}
                aria-disabled={disabled ? true : undefined}
                onClick={() => {
                  if (!disabled) setOpen(true);
                }}
                className="h-[72px] w-[72px] rounded-xl border border-primary/20 bg-primary/5 flex flex-col items-center justify-center gap-1 text-foreground/70 outline-none transition hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={disabled}
              >
                <ImagePlus className="size-5" />
                <span className="text-[10px] leading-none text-foreground/80 max-w-[56px] text-center truncate">
                  {label}
                </span>
              </button>
              {items.length > 0 ? (
                <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-[10px] leading-none rounded-full h-5 min-w-5 px-1 flex items-center justify-center">
                  {items.length}
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent form="standard" size="compact">
            <DialogTitle>{label}</DialogTitle>
            {upload}
            {displayErrorText ? (
              <p className="text-xs text-destructive">{displayErrorText}</p>
            ) : helperText ? (
              <p className="text-xs text-muted-foreground">{helperText}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {translate("common:actions.close", "关闭")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className={iconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
      <FieldLabel label={label} useIconLabels={iconLabels} iconVariant="file" className="mb-1" fieldKey={String(field.key)} fieldType={field.type} />
      {upload}
      {displayErrorText ? (
        <p className="text-xs text-destructive">{displayErrorText}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  );
};
