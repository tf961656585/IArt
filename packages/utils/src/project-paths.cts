import fs from 'node:fs';
import path from 'node:path';

const PROJECT_FOLDER_EXT = '.iartproj';
const PROJECT_FOLDER_PATHS = {
  MANIFEST: 'manifest.json',
  NODE_GRAPH: 'nodeGraph.json',
  SQLITE: 'project.sqlite',
  INDEX: 'index.json',
  MODEL_NODE_USAGE: 'model-node-usage.json',
  NODE_TYPE_USAGE: 'node-type-usage.json',
  NODE_PALETTE_PINS: 'node-palette-pins.json',
  CHARACTER_PINS: 'character-pins.json',
  MEDIA_DIR: 'media',
  REQUEST_LOGS_DIR: 'request-logs',
  LOCK_FILE: '.iart-lock',
};

const getProjectFolderPaths = (projectFolderPath: string): {
  root: string;
  manifest: string;
  nodeGraph: string;
  sqlite: string;
  index: string;
  modelNodeUsage: string;
  nodeTypeUsage: string;
  nodePalettePins: string;
  characterPins: string;
  media: string;
  requestLogs: string;
  lock: string;
} | null => {
  if (!projectFolderPath) return null;
  return {
    root: projectFolderPath,
    manifest: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.MANIFEST),
    nodeGraph: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.NODE_GRAPH),
    sqlite: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.SQLITE),
    index: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.INDEX),
    modelNodeUsage: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.MODEL_NODE_USAGE),
    nodeTypeUsage: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.NODE_TYPE_USAGE),
    nodePalettePins: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.NODE_PALETTE_PINS),
    characterPins: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.CHARACTER_PINS),
    media: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.MEDIA_DIR),
    requestLogs: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.REQUEST_LOGS_DIR),
    lock: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.LOCK_FILE),
  };
};

const isValidProjectFolder = (folderPath: unknown): boolean => {
  if (!folderPath || typeof folderPath !== 'string') return false;
  const paths = getProjectFolderPaths(folderPath);
  if (!paths) return false;
  return fs.existsSync(paths.sqlite) || fs.existsSync(paths.manifest);
};

export = {
  PROJECT_FOLDER_EXT,
  PROJECT_FOLDER_PATHS,
  getProjectFolderPaths,
  isValidProjectFolder,
};
