"use client";

/**
 * 判断错误原文是否只对排查者有意义。这类原文（压缩错误码、英文断言、
 * 带绝对路径的加载失败等）不直接印给用户看，但仍然完整保留在「复制错误详情」里。
 */
const looksLikeDeveloperOnlyMessage = (text: string): boolean => {
  if (text.trim().length < 6) return true;
  return [
    /Minified React error/i,
    /react\.dev\/errors/i,
    /Maximum update depth/i,
    /^TypeError\b|^ReferenceError\b|^SyntaxError\b|^RangeError\b/i,
    /Cannot read propert/i,
    /\bis not a function\b|\bis not defined\b|\bis not a constructor\b/i,
    /Failed to fetch dynamically imported module/i,
    /Loading chunk \d+ failed/i,
    /^Error: /,
    /\bat\s+\S+\s+\(/,
    /https?:\/\//,
    /\/(Users|home|var|opt|Applications)\//,
    /[A-Za-z]:\\/,
  ].some((pattern) => pattern.test(text));
};

export const getUserFacingErrorMessage = (error: Error): string => {
  const raw = error.message.trim();
  if (!raw || looksLikeDeveloperOnlyMessage(raw)) {
    return "刚才的操作没能完成，界面已经停下来了。请点「重新加载编辑器」继续；如果反复出现，请把错误详情发给我们，我们会尽快定位。";
  }
  return `${raw}\n\n请点「重新加载编辑器」继续；如果反复出现，请把错误详情发给我们，我们会尽快定位。`;
};

const sanitizeForJson = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
};

/**
 * 「复制错误详情」写入剪贴板的内容。这部分是给排查用的原始材料，
 * 不渲染在界面上；界面上只出现一句用户能读懂的话。
 */
export const buildDiagnosticText = (params: {
  error: Error;
  componentStack: string | null;
  lastUnhandledError: unknown;
}): string => {
  const { error, componentStack, lastUnhandledError } = params;
  return JSON.stringify(
    {
      title: "IARTStudio Editor diagnostic error",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      lastUnhandledError,
      componentStack,
      location: typeof window !== "undefined" ? window.location.href : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    },
    sanitizeForJson,
    2,
  );
};
