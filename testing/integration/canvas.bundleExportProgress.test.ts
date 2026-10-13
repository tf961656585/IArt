import { describe, expect, it, vi } from 'vitest';
import { buildBundleExport, exportNodeGraphToBundleFile } from '@/features/canvas/export/exportBundle';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import { triggerBlobDownload } from '@/client/utils/fileSaver';

vi.mock('@/client/utils/fileSaver', () => ({
  triggerBlobDownload: vi.fn(async () => undefined),
}));

const triggerBlobDownloadMock = vi.mocked(triggerBlobDownload);

describe('bundle export progress + cancel', () => {
  it('emits progress updates and completes zip stage', async () => {
    const onProgress = vi.fn();
    const snippet = createNodeGraph({ name: 'Progress' });

    await buildBundleExport(snippet, 'dev', { customFileName: 'progress-test', onProgress });

    expect(onProgress).toHaveBeenCalled();
    const events: unknown[] = onProgress.mock.calls.map(([event]: [unknown]) => event);
    expect(events).toContainEqual(
      expect.objectContaining({ stage: 'zip', messageKey: 'bundle.export.zip', percent: 100 })
    );
  });

  it('cancel aborts export and does not trigger download', async () => {
    const controller = new AbortController();
    controller.abort();
    const snippet = createNodeGraph({ name: 'Cancel' });

    await expect(
      exportNodeGraphToBundleFile(snippet, 'dev', {
        customFileName: 'cancel-test',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(triggerBlobDownloadMock).not.toHaveBeenCalled();
  });
});
