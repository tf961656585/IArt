/**
 * 退役的 Escape 专有透传 props（spec「退役清单」）。
 *
 * 包装组件把 Escape 处理交给浮层栈后，`onEscapeKeyDown` 这类「绕栈的旧通道」必须从
 * 公共 API 上消失：留着就等于给业务方留了一条能抢在栈之前处理 Esc 的后门。
 *
 * 为什么名单字面量放在 `overlay-stack/` 目录内：`guard:escape-stack` 在其余路径阻断
 * `onEscape*` 标识符，本目录是豁免事实源。名单收敛在这里，既让守卫保持绿灯，
 * 也让「哪些 prop 已退役」只有一处事实源 —— 后续波次新增包装组件时从这里取。
 */
export type RetiredEscapePropName = "onEscapeKeyDown"

/** 去掉退役 props 后的组件公共 API 类型。 */
export type WithoutRetiredEscapeProps<T> = Omit<T, RetiredEscapePropName>
