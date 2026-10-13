"use client";

import { useEffect } from "react";
import { useAppStore } from "@/client/store/appStore";

// 根据应用内主题状态动态设置 <meta name="theme-color">，
// 以匹配已安装 PWA/移动端状态栏与应用 UI 的对比度。
const ThemeColorMetaClient: React.FC = () => {
  const mode = useAppStore((s) => s.themeMode);

  useEffect(() => {
    const color = mode === "dark" ? "#0f0f10" : "#ffffff";
    let meta = document.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"][data-runtime="true"]'
    );
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("data-runtime", "true");
      document.head.appendChild(meta);
    }
    meta.content = color;
  }, [mode]);

  return null;
};

export default ThemeColorMetaClient;

