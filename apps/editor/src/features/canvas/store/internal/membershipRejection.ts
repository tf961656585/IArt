/**
 * 非法成员关系的统一拒绝出口（AG-CN-012 / AG-CN-013，spec：docs/runtime/画布节点组.md
 * 「历史与持久化」读取口径 + 「验收：AG-CN-013 旧输入拒绝」）：
 * 打开项目时 `groupId` 悬空（指向不存在节点）、指向非容器节点、组持有 groupId、
 * Agent 容器套 Agent 容器或自指——非法引用使输入不能进入正式打开态，不修复、不降级、不提示迁移。
 *
 * 用户可见 message 只写「发生了什么 + 能做什么」；稳定错误码、违规原因与节点 id 不拼进
 * message——它们落在 error 字段与 console.error 日志（排查材料留痕，但不作为用户看到的句子）。
 * 口径与 legacyModelNodeRejection 同构。
 */
import type { GraphNode } from '../../types';
import { findIllegalMemberships, type MembershipViolation } from '../../services/groupMembership';

export const ILLEGAL_MEMBERSHIP_ERROR_CODE = 'illegal-membership';

export const ILLEGAL_MEMBERSHIP_USER_MESSAGE =
  '这个项目里有一部分内容当前版本打不开。请新建一个项目后重新生成内容。';

/**
 * 构造拒绝打开非法成员关系的错误。
 *
 * @param violations 全部非法成员引用（只进日志与 error.violations，不上界面）
 * @param source 触发位置（load / repair），只进日志用于定位
 */
export const createIllegalMembershipRejection = (
  violations: readonly MembershipViolation[],
  source: string,
): Error => {
  const first = violations[0];
  console.error(
    `[canvas:load] ${ILLEGAL_MEMBERSHIP_ERROR_CODE} 拒绝打开非法成员引用 source=${source} count=${violations.length} nodeId=${first !== undefined ? first.nodeId : ''} reason=${first !== undefined ? first.reason : ''}`,
    { violations },
  );
  const error = new Error(ILLEGAL_MEMBERSHIP_USER_MESSAGE);
  error.name = 'IllegalMembershipError';
  return Object.assign(error, {
    code: ILLEGAL_MEMBERSHIP_ERROR_CODE,
    violations: [...violations],
  });
};

/**
 * 断言一批节点的成员关系全部合法；命中违规即抛拒绝错误（条件跳过必留痕：抛错前 console.error）。
 */
export const assertLegalMemberships = (
  nodes: readonly GraphNode[],
  source: string,
): void => {
  const violations = findIllegalMemberships(nodes);
  if (violations.length === 0) return;
  throw createIllegalMembershipRejection(violations, source);
};
