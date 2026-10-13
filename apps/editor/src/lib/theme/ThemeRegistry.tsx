"use client";

import type { PropsWithChildren } from "react";

export type ThemeRegistryProps = PropsWithChildren;

// Tailwind/shadcn 环境下不需要 Emotion，透明传递 children
const ThemeRegistry: React.FC<ThemeRegistryProps> = ({ children }) => {
  return <>{children}</>;
};

export default ThemeRegistry;
