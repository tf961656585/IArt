/**
 * 内部构建错误的兜底翻译：把仍会以原文抛出的内部消息，换成用户能处理的一句话。
 *
 * 只保留当前确实存在抛出点的匹配项。模型表单链路（schema.payload 未定义、未配置表单、
 * 未知表单配置类型、schema 模块无效）的抛出点已改为直接抛出用户措辞，模型资产刷新与
 * 图像输入字段相关的上游也已不存在，对应的匹配项一并删除——留着会让人误以为这些内部
 * 消息仍可能到达界面（口径见 docs/ui-copy-standard.md 第 4 条）。
 */
export const normalizeInternalBuildErrorMessage = (message: string): string | null => {
  const lower = message.toLowerCase();
  if (message.includes('Hub 模式下禁止前端直连远程接口')) {
    return '当前请求无法直接执行，请重新打开项目后重试。';
  }
  if (lower.includes('multipart') || lower.includes('formdata')) {
    return '当前模型请求准备失败，请重试。';
  }
  if (lower.includes('transform') || message.includes('路径定义与数据结构不匹配')) {
    return '当前模型参数不完整或格式不正确，请检查参数后重试。';
  }
  return null;
};
