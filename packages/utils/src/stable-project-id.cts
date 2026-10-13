import crypto from 'node:crypto';

const STABLE_PROJECT_ID_PREFIX = 'spid_';

const generateStableProjectId = () => {
  const bytes = crypto.randomBytes(12);
  return `${STABLE_PROJECT_ID_PREFIX}${bytes.toString('hex')}`;
};

const isStableProjectId = (value: unknown) => {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${STABLE_PROJECT_ID_PREFIX}[a-f0-9]{24}$`).test(value);
};

export = {
  STABLE_PROJECT_ID_PREFIX,
  generateStableProjectId,
  isStableProjectId,
};
