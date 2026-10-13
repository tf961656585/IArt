import React from "react";
import { ImagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getSemanticIcon } from "@/features/workspace/schema/renderers/FieldIconHelper";

interface FieldLabelProps {
  label: string | undefined;
  useIconLabels: boolean | undefined | undefined;
  iconVariant: "default" | "file" | undefined;
  className: string | undefined;
  fieldKey: string | undefined;
  fieldType: string | undefined;
}

export const FieldLabel: React.FC<FieldLabelProps> = ({
  label,
  useIconLabels,
  iconVariant = "default",
  className,
  fieldKey,
  fieldType,
}) => {
  if (!label) return null;
  const wrapperClassName = ["dock-field-label", className].filter(Boolean).join(" ");
  if (!useIconLabels) {
    return (
      <span className={wrapperClassName}>
        <Label>{label}</Label>
      </span>
    );
  }
  const IconComponent =
    iconVariant === "file"
      ? ImagePlus
      : getSemanticIcon({
          fieldKey,
          fieldType,
          label,
        });
  return (
    <span className={wrapperClassName}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label}>
            <IconComponent className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  );
};
