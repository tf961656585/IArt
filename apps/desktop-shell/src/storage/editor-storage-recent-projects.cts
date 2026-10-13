import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * lastOpenedAt 兼容性（spec docs/integrations/CLI与本地Agent集成.md §5.1 project list
 * 需要最近打开时间；持久化 JSON schema 演进纪律）：
 * recent-projects.json 是非 .strict() 的直读直写 JSON（逐条形状守卫，非 schema 校验），
 * 新增可选字段 `lastOpenedAt?: number | null`：
 * - 旧文件缺该字段的条目**不得被丢弃**（读侧守卫不再要求该键存在）；
 * - 读取方把缺失/非法值按「从未打开」处理（getEntryLastOpenedAt 归一为 null）。
 */
export interface ProjectRegistryEntry {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt?: number | null;
}

const getRecentProjectsPath = (): string => {
  const appDataDir =
    process.env['NODE_ENV'] === 'development'
      ? path.join(os.homedir(), '.iart-studio-dev')
      : path.join(os.homedir(), '.iart-studio');
  return path.join(appDataDir, 'recent-projects.json');
};

export const readRecentProjects = (): ProjectRegistryEntry[] => {
  const filePath = getRecentProjectsPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ProjectRegistryEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Partial<ProjectRegistryEntry>;
      return (
        typeof row.nodeGraphId === 'string' &&
        typeof row.name === 'string' &&
        typeof row.path === 'string' &&
        typeof row.createdAt === 'number' &&
        typeof row.savedAt === 'number'
      );
    });
  } catch {
    return [];
  }
};

const writeRecentProjects = (projects: ProjectRegistryEntry[]): void => {
  const filePath = getRecentProjectsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(projects, null, 2));
  fs.renameSync(tmpPath, filePath);
};

export const addRecentProject = (entry: ProjectRegistryEntry): void => {
  const projects = readRecentProjects().filter((project) => project.path !== entry.path);
  projects.unshift(entry);
  writeRecentProjects(projects);
};

export const removeRecentProject = (projectPath: string): void => {
  const projects = readRecentProjects().filter((project) => project.path !== projectPath);
  writeRecentProjects(projects);
};

/**
 * 项目打开链的最近打开时间更新（spec §5.1 project list 的 last_opened_at 事实源）：
 * 仅更新 lastOpenedAt 并按既有 addRecentProject 语义移到列表首位（与 openProject 打开链
 * 一致）；项目不在注册表时不新增条目（debug 留痕），由打开主链负责登记。
 */
export const touchRecentProjectOpenedAt = (projectPath: string, openedAt: number): void => {
  const normalized = path.resolve(projectPath);
  const entry = readRecentProjects().find((project) => project.path === normalized);
  if (entry === undefined) {
    console.debug('[recent-projects] 更新最近打开时间时项目不在注册表，跳过', { path: normalized });
    return;
  }
  addRecentProject({ ...entry, lastOpenedAt: openedAt });
};

/** 注册表条目的最近打开时间归一：缺失/非法一律按「从未打开」null 承载，不做第二兜底源。 */
export const getEntryLastOpenedAt = (entry: ProjectRegistryEntry): number | null =>
  typeof entry.lastOpenedAt === 'number' && Number.isFinite(entry.lastOpenedAt) ? entry.lastOpenedAt : null;
