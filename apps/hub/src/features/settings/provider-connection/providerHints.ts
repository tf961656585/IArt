/**
 * 跨设置页子单元的短提示传递键。
 *
 * 设置页一个导航项 = 一个页面，切页即卸载源页面：源页面上显示的提示会随卸载消失。
 * 需要把「刚才在另一页做的那件事」带到目标页时（如接口格式页的「用此格式添加模型」
 * 跳到服务商页），用 sessionStorage 传一句提示，目标页挂载时读取并清除——
 * 与 `PENDING_SETTINGS_SECTION_KEY` 同源的理由：页面未挂载时 props 传递会丢。
 */
export const PROVIDER_ADD_MODEL_HINT_KEY = 'hub:pending-provider-add-model-hint';

/**
 * 从「添加模型」跳到「接口格式」页新建的意图键。
 *
 * 值 = `'providers'` 表示保存后回到服务商页；缺省或其它值表示留在接口格式页。
 */
export const INTERFACE_FORMAT_CREATE_INTENT_KEY = 'hub:pending-interface-format-create';
