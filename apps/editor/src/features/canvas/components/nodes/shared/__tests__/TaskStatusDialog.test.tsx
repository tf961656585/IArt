import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskStatusDialog } from '../TaskStatusDialog';

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
});
