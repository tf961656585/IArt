/**
 * skills 特性域入口（纯 barrel）。
 *
 * 目录拉取、错误映射、版本比较与 bundle URL 构建的现役实现在 `client/skills`——
 * 本文件曾内联一份与它逐字节相同的副本（1-97 行），无人调用，已于 2026-09-15 清除：
 * 同一概念不留第二套实现，否则改文案时只改一处、另一处会静默漂移。
 */

export { SkillsTab } from './SkillsTab';
export { useSkills } from './SkillsTab.hooks';
