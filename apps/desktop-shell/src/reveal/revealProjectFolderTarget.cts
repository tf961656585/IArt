import * as fs from 'node:fs';
import * as path from 'node:path';
import { RevealProjectFolderResultSchema } from '@iart/contracts';

type RevealProjectFolderTargetParams = {
  targetPath: string | null | undefined;
  shell: {
    showItemInFolder: (filePath: string) => void;
  } | null | undefined;
};

/**
 * 定位项目目录或导出文件（spec docs/editor/本地文件快捷跳转.md）：
 *
 * 同一通道服务两种语义——目录类（Hub 项目卡「打开所在文件夹」，LFJ-010 定位并高亮
 * 目录本身）与文件类（Hub 导出项目完成后自动定位 .iarts.zip，判据五历史特例，定位并
 * 高亮文件本身）。stat 对文件与目录都放行，shell.showItemInFolder 对文件高亮文件本身、
 * 对目录高亮目录本身，目录语义与既有行为保持不变。
 *
 * 目标不存在时返回 path-missing 并留 debug 日志（LFJ-003/LFJ-011：不静默、不以自动
 * 打开其他位置替代明确反馈）。
 */
export const revealProjectFolderTarget = async ({
  targetPath,
  shell,
}: RevealProjectFolderTargetParams = {} as RevealProjectFolderTargetParams) => {
  const normalized = typeof targetPath === 'string' && targetPath.trim() ? targetPath.trim() : '';
  if (!normalized || !path.isAbsolute(normalized)) {
    return RevealProjectFolderResultSchema.parse({ ok: false, reason: 'not-absolute', path: normalized });
  }

  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(normalized);
  } catch (error) {
    console.debug('[desktop] reveal-project-folder: target missing', { targetPath: normalized, error });
  }
  if (!stat) {
    return RevealProjectFolderResultSchema.parse({ ok: false, reason: 'path-missing', path: normalized });
  }

  if (shell !== null && shell !== undefined && shell.showItemInFolder !== null && shell.showItemInFolder !== undefined) {
    shell.showItemInFolder(normalized);
  }
  return RevealProjectFolderResultSchema.parse({ ok: true, path: normalized });
};
