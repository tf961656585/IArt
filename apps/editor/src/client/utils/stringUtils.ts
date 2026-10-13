/**
 * 字符串归一化工具
 * - toKebabCase: 将输入统一转为 kebab-case（兼容空白/驼峰/特殊字符）
 * - normalizeIdentifier: 针对 schema/model 标识的轻量清洗，主要用于生成候选文件名
 */

export const toKebabCase = (value: string): string => {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '-')
    .replace(/[_\s]+/g, '-')
    .replace(/[:/@#\\]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export const normalizeIdentifier = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[:/@#\\\s]+/g, '-')
    .replace(/[^a-z0-9-.]+/g, '');
};

