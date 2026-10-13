"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import {
  type ElementType,
  type JSX,
  memo,
  useMemo,
} from "react";

export type TextShimmerProps = {
  children: string;
} & Partial<{
  as: ElementType | undefined;
  className: string | undefined;
  duration: number | undefined;
  spread: number | undefined;
}>;

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = motion.create(
    Component as keyof JSX.IntrinsicElements
  );

  const dynamicSpread = useMemo(
    () => ((children !== null && children !== undefined ? children.length : undefined) ?? 0) * spread,
    [children, spread]
  );

  const backgroundGradient = useMemo(
    () =>
      `linear-gradient(90deg,#0000 calc(50% - ${dynamicSpread}px),var(--color-background),#0000 calc(50% + ${dynamicSpread}px))`,
    [dynamicSpread]
  );

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={{
        backgroundImage: `${backgroundGradient}, linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))`,
      }}
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: "linear",
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
