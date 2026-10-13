/** 媒体时长展示格式化（北京时间无关的纯展示工具，秒 → `m:ss`）。 */
export const formatMediaTime = (timeSec: number): string => {
  if (!Number.isFinite(timeSec)) return "0:00";
  const time = Math.max(0, Math.floor(timeSec));
  const minutes = Math.floor(time / 60);
  const seconds = time % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};
