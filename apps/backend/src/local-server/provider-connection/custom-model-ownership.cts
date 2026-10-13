import { getConnection } from './connection-store.cts';

/**
 * 自建模型记录的接入归属校验（spec 03 §6.1：创建记录时校验「连接存在、enabled、有凭证」，
 * 一次写入完成）。
 *
 * 2026-09-26 起协议归属模型级：协议由请求体自带（对话记录 `protocol_adapter_id`、生成记录
 * `family_adapter_id`），本模块不再校验「连接协议族匹配」——一条连接可承载任意协议族的模型，
 * 连接只承载地址与凭证。协议本身的合法性由 contracts schema 值域保证（对话族 enum /
 * 生成族 enum，生成族 enum 与已登记族模板一一对应、由族模板一致性门禁钉住），写入路径无需
 * 重复校验。
 *
 * 返回 null = 通过；否则返回用户可读的拒绝原因（路由按 400 回给界面）。
 */
const describeConnectionOwnershipError = (connectionId: string): string | null => {
  const connection = getConnection(connectionId);
  if (!connection) return '没有找到这条服务商连接，请先在服务商设置里创建并启用它';
  if (connection.lifecycle !== 'enabled') {
    return '这条服务商连接当前未启用，请先启用再添加模型';
  }
  if (!connection.has_credential || !connection.credential_ref) {
    return '这条服务商连接还没有配置密钥，请先填写密钥再添加模型';
  }
  return null;
};

export { describeConnectionOwnershipError };
