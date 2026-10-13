import mediaFileKeyModule = require('./media-file-key.cjs');
const { extractMediaFileKey } = mediaFileKeyModule;
const parseFilesKeyFromUrl = extractMediaFileKey;
export = { parseFilesKeyFromUrl, extractMediaFileKey };
