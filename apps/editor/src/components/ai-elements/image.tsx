import { cn } from "@/lib/utils";
import type { Experimental_GeneratedImage } from "ai";
import NextImage from "next/image";

export type ImageProps = Experimental_GeneratedImage & {
  className: string | undefined;
  alt: string | undefined;
};

export const Image = ({
  base64,
  uint8Array: _uint8Array,
  mediaType,
  ...props
}: ImageProps) => (
  <NextImage
    {...props}
    alt={props.alt ?? ""}
    className={cn(
      "h-auto max-w-full overflow-hidden rounded-md",
      props.className
    )}
    height={512}
    unoptimized
    width={512}
    src={`data:${mediaType};base64,${base64}`}
  />
);
