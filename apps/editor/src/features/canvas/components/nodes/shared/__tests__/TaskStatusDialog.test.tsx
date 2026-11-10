import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TaskStatusDialog } from '../TaskStatusDialog';

const { focusHubModelProvidersMock } = vi.hoisted(() => ({
  focusHubModelProvidersMock: vi.fn(),
}));

vi.mock('@/features/promptdock/hubFocus', () => ({
  focusHubModelProviders: focusHubModelProvidersMock,
}));

beforeEach(() => {
  focusHubModelProvidersMock.mockReset();
});

describe('TaskStatusDialog', () => {
  it('submitting + uploading_input 会显示上传图像中', () => {
    render(
      <TaskStatusDialog
        open
        onOpenChange={() => {}}
        title={undefined}
        taskInfo={{
          taskId: 'task-uploading-1',
          modelId: 'gemini-3.1-flash-image',
          remoteRequestId: undefined,
          taskIndex: 0,
          status: 'submitting',
          progress: { phase: 'uploading_input' },
          error: undefined,
          failure: null,
          batchId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }}
        backendMessage={null}
        batchId={undefined}
        onCopyTaskId={() => {}}
        onOpenArchive={() => {}}
        canOpenArchive={false}
        openArchiveDisabledReason={undefined}
      />,
    );

    expect(screen.getByText('上传图像中')).toBeInTheDocument();
  });

  it('失败弹窗使用短摘要并把原始详情限制在详情区', () => {
    const rawText = 'check status failed: {"code":"PUBLIC_ERROR_SEXUAL","failureReasons":["NCII"],"mediaMetadata":{"prompt":"very long json"}} task_execution_failed';
    render(
      <TaskStatusDialog
        open
        onOpenChange={() => {}}
        title={undefined}
        taskInfo={{
          taskId: 'task-failed-1',
          modelId: 'doubao-seedance-2-0-260128',
          remoteRequestId: undefined,
          taskIndex: 0,
          status: 'failed',
          progress: null,
          error: undefined,
          failure: {
            code: 'PUBLIC_ERROR_SEXUAL',
            message: '内容安全策略拦截',
            userMessage: '内容安全策略拦截',
            backendMessage: rawText,
            retryable: false,
            details: { failureReasons: ['NCII'] },
          },
          batchId: undefined,
          createdAt: 1,
          updatedAt: 2,
        }}
        backendMessage={null}
        batchId={undefined}
        onCopyTaskId={() => {}}
        onOpenArchive={() => {}}
        canOpenArchive={false}
        openArchiveDisabledReason={undefined}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-[90vh]');
    expect(dialog).toHaveClass('overflow-hidden');
    expect(screen.getByText('失败原因')).toBeInTheDocument();
    expect(screen.getByText('内容安全策略拦截')).toBeInTheDocument();
    expect(screen.getByText('PUBLIC_ERROR_SEXUAL')).toBeInTheDocument();
    expect(screen.getByText('NCII')).toBeInTheDocument();
    expect(screen.queryByText('失败摘要')).toBeNull();

    // 原始 backendMessage 只挂在「错误详情」区的「服务返回内容」折叠块里
    const techSummaries = screen.getAllByText('服务返回内容');
    techSummaries[techSummaries.length - 1]?.click();
    expect(screen.getByText(rawText)).toBeInTheDocument();
    expect(screen.getAllByText(rawText)).toHaveLength(1);
  });

  it('密钥缺失失败：动作区显示「去填写密钥」，点击聚焦 Hub 服务商设置', () => {
    render(
      <TaskStatusDialog
        open
        onOpenChange={() => {}}
        title={undefined}
        taskInfo={{
          taskId: 'task-credential-missing-1',
          modelId: 'veo_3_1-fast',
          remoteRequestId: undefined,
          taskIndex: 0,
          status: 'failed',
          progress: null,
          error: undefined,
          failure: {
            code: 'credential_missing',
            message: 'credential missing',
            userMessage: '没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。',
            details: { reason: 'absent' },
          },
          batchId: undefined,
          createdAt: 1,
          updatedAt: 2,
        }}
        backendMessage={null}
        batchId={undefined}
        onCopyTaskId={() => {}}
        onOpenArchive={() => {}}
        canOpenArchive={false}
        openArchiveDisabledReason={undefined}
      />,
    );

    expect(
      screen.getByText('没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。'),
    ).toBeInTheDocument();

    const credentialFix = screen.getByRole('button', { name: '去填写密钥' });
    expect(credentialFix).toHaveTextContent('去填写密钥');

    fireEvent.click(credentialFix);
    expect(focusHubModelProvidersMock).toHaveBeenCalledTimes(1);
  });

  it('其他失败码不出现「去填写密钥」', () => {
    render(
      <TaskStatusDialog
        open
        onOpenChange={() => {}}
        title={undefined}
        taskInfo={{
          taskId: 'task-failed-2',
          modelId: 'veo_3_1-fast',
          remoteRequestId: undefined,
          taskIndex: 0,
          status: 'failed',
          progress: null,
          error: undefined,
          failure: {
            code: 'task_execution_failed',
            message: '提交失败',
            stage: 'submit',
          },
          batchId: undefined,
          createdAt: 1,
          updatedAt: 2,
        }}
        backendMessage={null}
        batchId={undefined}
        onCopyTaskId={() => {}}
        onOpenArchive={() => {}}
        canOpenArchive={false}
        openArchiveDisabledReason={undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: '去填写密钥' })).toBeNull();
  });

  /** footer 的复制按钮复制的是任务编号，不是错误详情文本；两者同名会让用户无法判断。 */
  it('footer 复制按钮标注为「复制任务编号」并触发 onCopyTaskId', () => {
    const onCopyTaskId = vi.fn();
    render(
      <TaskStatusDialog
        open
        onOpenChange={() => {}}
        title={undefined}
        taskInfo={{
          taskId: 'task-copy-1',
          modelId: 'gpt-image-1',
          remoteRequestId: undefined,
          taskIndex: 0,
          status: 'failed',
          progress: null,
          error: undefined,
          failure: { code: 'connection_dropped', stage: 'submit', message: '提交失败' },
          batchId: undefined,
          createdAt: 1,
          updatedAt: 2,
        }}
        backendMessage={null}
        batchId={undefined}
        onCopyTaskId={onCopyTaskId}
      />,
    );

    const copyTaskId = screen.getByRole('button', { name: '复制任务编号' });
    // 「复制错误详情」只剩错误详情区块里那一个，footer 不再重名
    expect(screen.getAllByRole('button', { name: '复制错误详情' })).toHaveLength(1);

    fireEvent.click(copyTaskId);
    expect(onCopyTaskId).toHaveBeenCalledTimes(1);
  });
});
