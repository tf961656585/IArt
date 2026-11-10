import type { ProviderConnection } from '@iart/contracts';

/**
 * 密钥状态词与弱保护说明的唯一实现（2026-10-29）。
 *
 * 详情头第二行与左侧服务商列表卡片共用本模块：同一个密钥状态在两处只有一套说法，
 * 不在两个组件里各拼一次字符串。
 *
 * 两个契约字段都是 `nullable().optional()`：`undefined` 与 `null` 一律按「没有该信息」处理
 * ——既不当异常态显示，也不抛错。后端从不验证密钥有效性，所以这里只有「已保存 / 需要重新填写」，
 * 不出现「无效 / 验证失败」（`docs/ui-copy-standard.md` 第 9 条：密钥用纯文本，不用胶囊）。
 */

/** 弱保护说明：只走「?」气泡（`docs/ui-copy-standard.md` 第 2 条），不常驻界面。 */
export const CREDENTIAL_WEAK_PROTECTION_HINT =
  '这台电脑没有可用的系统安全存储，密钥只做了简单编码存在本机，本机的其他程序可以读到。换一台有系统安全存储的电脑重新填写，就能恢复系统级保护。';

export type CredentialDisplay = {
  /** 状态词：详情与列表共用同一份文本 */
  text: string;
  /** 已保存但读不出来：用户唯一的恢复动作是重新填写密钥 */
  needsReentry: boolean;
  /** 本机没有系统钥匙串，密钥只做了可逆编码（决定「?」气泡是否出现） */
  weakProtection: boolean;
};

export function credentialDisplay(connection: ProviderConnection): CredentialDisplay {
  if (!connection.has_credential) {
    // 没有密钥时保护等级与可读状态都没有意义（契约里此时为 null），沿用改造前的说法
    return { text: '还没设置密钥', needsReentry: false, weakProtection: false };
  }
  const needsReentry = connection.credential_status === 'needs_reentry';
  const weakProtection = connection.credential_protection === 'obfuscated';
  if (needsReentry) {
    // 读不出来时先说最要紧的恢复动作：弱保护后缀只挂在正常态
    return { text: '密钥需要重新填写', needsReentry: true, weakProtection };
  }
  return {
    text: weakProtection ? '密钥已保存（弱保护）' : '密钥已保存',
    needsReentry: false,
    weakProtection,
  };
}
