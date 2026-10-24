// @spec: CLI-014, CLI-027, CLI-028, CLI-029, CLI-030, CLI-048, CLI-051
import { describe, expect, it } from 'vitest';

import {
  CliCommandLogEntrySchema,
  CliEntryOperationResultSchema,
  CliStatusDtoSchema,
} from '../src/cli-contract';
import {
  CLI_GET_STATUS_CHANNEL,
  CLI_PROXY_REQUEST_CHANNEL,
  CLI_PROXY_RESPONSE_CHANNEL,
  CLI_REGISTER_ENTRY_CHANNEL,
  CLI_UNREGISTER_ENTRY_CHANNEL,
} from '../src/cli-settings-channels';
import * as contracts from '../src';
import { ISO } from './fixtures/cli-contract-samples';

/**
 * 设置页「命令行工具」DTO 契约测试。
 *
 * 口径：docs/integrations/CLI与本地Agent集成.md §6.2/§8 设置页 DTO。
 */

describe('设置页「命令行工具」DTO（spec §6.2/§8）', () => {
  it('命令日志条目：合法样例 parse 通过', () => {
    expect(
      CliCommandLogEntrySchema.safeParse({
        timestamp: ISO,
        command: 'generate',
        paramsSummary: 'model=model-a count=2',
        status: 'success',
        durationMs: 120,
      }).success,
    ).toBe(true);
    expect(
      CliCommandLogEntrySchema.safeParse({
        timestamp: ISO,
        command: 'generate',
        paramsSummary: '',
        status: 'error',
        durationMs: 0,
        errorCode: 'invalid_reference',
      }).success,
    ).toBe(true);
  });

  it('命令日志条目：非法值被拒绝', () => {
    const valid = {
      timestamp: ISO,
      command: 'generate',
      paramsSummary: '',
      status: 'success',
      durationMs: 1,
    };
    expect(
      CliCommandLogEntrySchema.safeParse({ ...valid, timestamp: '2026-10-07 00:00:00' }).success,
    ).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, status: 'ok' }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, errorCode: 'timeout' }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('CLI 状态 DTO：recentCommands 最多 20 条，port 可空，entry 为五态详情', () => {
    const entry = {
      timestamp: ISO,
      command: 'project.list',
      paramsSummary: '',
      status: 'success',
      durationMs: 1,
    };
    const entryDetail = {
      state: 'registered',
      entryPath: '/tmp/example/iart',
      legacyEntryPath: null,
      pathSetupRequired: false,
    };
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: [],
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: false,
        port: null,
        discoveryFileValid: false,
        entry: { state: 'unsupported', entryPath: null, legacyEntryPath: null, pathSetupRequired: false },
        recentCommands: [],
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: Array.from({ length: 20 }, () => entry),
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: Array.from({ length: 21 }, () => entry),
      }).success,
    ).toBe(false);
  });

  it('CLI 状态 DTO：entry 五态边界——五态合法，缺失/非法被拒绝（spec §8 注册状态）', () => {
    const base = {
      serviceRunning: true,
      port: 8765,
      discoveryFileValid: true,
      recentCommands: [],
    };
    const detail = (state: string) => ({ state, entryPath: '/tmp/example/iart', legacyEntryPath: null, pathSetupRequired: false });
    for (const state of ['unsupported', 'missing', 'registered', 'stale', 'foreign']) {
      expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail(state) }).success).toBe(true);
    }
    expect(CliStatusDtoSchema.safeParse({ ...base }).success).toBe(false);
    // 旧三态命名（modified 等）与旧布尔字段（entryRegistered）不得回归
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('modified') }).success).toBe(false);
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('registered'), entryRegistered: true }).success).toBe(false);
    // entry 详情字段边界：entryPath/legacyEntryPath 可 null；pathSetupRequired 必须布尔；多余键拒绝
    expect(
      CliStatusDtoSchema.safeParse({
        ...base,
        entry: { state: 'stale', entryPath: null, legacyEntryPath: '/usr/local/bin/iart', pathSetupRequired: true },
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        ...base,
        entry: { state: 'registered', entryPath: '/x', legacyEntryPath: '/y', pathSetupRequired: 'yes' },
      }).success,
    ).toBe(false);
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('registered'), extra: 1 }).success).toBe(false);
  });

  it('CLI 设置页通道常量：三条通道命名稳定且经 barrel 导出（spec §8）', () => {
    expect(CLI_GET_STATUS_CHANNEL).toBe('cli:get-status');
    expect(CLI_REGISTER_ENTRY_CHANNEL).toBe('cli:register-entry');
    expect(CLI_UNREGISTER_ENTRY_CHANNEL).toBe('cli:unregister-entry');
    // 与代理执行通道命名空间区分（cli-proxy-* 与 cli:* 两族互不重叠）
    expect(CLI_GET_STATUS_CHANNEL).not.toBe(CLI_PROXY_REQUEST_CHANNEL);
    expect(CLI_GET_STATUS_CHANNEL).not.toBe(CLI_PROXY_RESPONSE_CHANNEL);
    // barrel 导出（消费端统一从 @iart/contracts 取用）
    expect(contracts.CLI_GET_STATUS_CHANNEL).toBe('cli:get-status');
    expect(contracts.CLI_REGISTER_ENTRY_CHANNEL).toBe('cli:register-entry');
    expect(contracts.CLI_UNREGISTER_ENTRY_CHANNEL).toBe('cli:unregister-entry');
  });

  it('入口注册操作结果 DTO：{ ok, message? } 形状边界（spec §8）', () => {
    expect(CliEntryOperationResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, message: '已注册。' }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: false, message: '没有权限写入命令入口目录。' }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: false }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: 'yes' }).success).toBe(false);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, message: '' }).success).toBe(false);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, extra: 1 }).success).toBe(false);
  });
});
