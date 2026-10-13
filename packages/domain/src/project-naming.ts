const INVALID_PROJECT_NAME_CHARS = /[<>:"/\\|?*]/g;
const PROJECT_NAME_SPACES = /\s+/g;

export const sanitizeProjectName = (projectName: string | null | undefined, fallback = '未命名项目'): string => {
  const safeName = typeof projectName === 'string' && projectName.trim() ? projectName.trim() : fallback;
  return safeName.replace(INVALID_PROJECT_NAME_CHARS, '_').replace(PROJECT_NAME_SPACES, '_').slice(0, 50);
};

export const generateProjectFolderName = (projectName: string | null | undefined, projectFolderExt: string): string => {
  return `${sanitizeProjectName(projectName)}${projectFolderExt}`;
};

export const generateProjectFolderNameWithSuffix = (
  baseName: string | null | undefined,
  suffix: number,
  projectFolderExt: string,
): string => {
  const safeName = sanitizeProjectName(baseName);
  return suffix > 1 ? `${safeName}(${suffix})${projectFolderExt}` : `${safeName}${projectFolderExt}`;
};
