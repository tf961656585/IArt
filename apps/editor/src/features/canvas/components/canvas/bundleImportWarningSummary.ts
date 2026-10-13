/**
 * 导入警告的界面聚合（文案规范：同一条警告只出现一次并带数量，不逐条刷屏）。
 *
 * 产生方已把节点 id / 文件内路径 / 版本号等排查材料写进 console，界面串只承载
 * 「发生了什么」；因此同类问题在去掉内部标识后是同一句话，去重即等价于归类。
 * 顺序按首次出现位置稳定保留。
 */
export const summarizeImportWarnings = (
  warnings: readonly string[],
): string[] => {
  const counts = new Map<string, number>();
  for (const warning of warnings) {
    const text = warning.trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) =>
    count > 1 ? `${text}（共 ${count} 处）` : text,
  );
};
