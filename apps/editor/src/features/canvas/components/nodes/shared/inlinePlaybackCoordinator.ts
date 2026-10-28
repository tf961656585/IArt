/**
 * 画布内联播放的互斥协调器（同屏唯一播放）。
 *
 * 设计依据：docs/editor/画布资产节点媒体播放-design.md §3.2。
 * 约束：同一时刻只有一个节点在播；开始播新的时暂停上一个。
 *
 * 使用方式：每个播放表面（视频 / 音频）持有一个稳定的 handle（pause 闭包），
 * 在 media play 事件里 claim、pause / ended 事件里 release。
 * 本模块不持有 React 状态——播放态由各表面自己的 state 承载。
 */

export type InlinePlaybackHandle = {
  pause: () => void;
};

let current: InlinePlaybackHandle | null = null;

export function claimInlinePlayback(handle: InlinePlaybackHandle): void {
  if (current !== null && current !== handle) current.pause();
  current = handle;
}

export function releaseInlinePlayback(handle: InlinePlaybackHandle): void {
  if (current === handle) current = null;
}
