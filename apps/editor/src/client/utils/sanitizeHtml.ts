import DOMPurify from "dompurify";

/**
 * 将任意HTML片段进行清洗，防止潜在的XSS脚本。
 * 该函数仅在浏览器环境中使用（依赖DOMPurify的默认window实现）。
 */
export const sanitizeHtml = (value: string | null | undefined): string => {
  if (!value) {
    return "";
  }
  return DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true },
  });
};

export default sanitizeHtml;
