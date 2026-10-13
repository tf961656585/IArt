import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const toPosix = (value) => value.split(path.sep).join('/');

export const escapeRegExp = (value) => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

export const globToRegExp = (pattern) => {
  const normalized = toPosix(pattern).replace(/^\.?\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      const after = normalized[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
};

export const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export const parseArgs = (argv, defaults) => {
  const args = {
    root: process.cwd(),
    policy: defaults.policy,
    fixtures: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--root') {
      args.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (item === '--policy') {
      args.policy = argv[index + 1] ?? defaults.policy;
      index += 1;
      continue;
    }
    if (item === '--fixture') {
      args.fixtures.push(argv[index + 1] ?? '');
      index += 1;
    }
  }

  return args;
};

export const compilePathPolicy = (policy) => ({
  zones: (policy.zones ?? policy.stableZones ?? []).map((item) => toPosix(item).replace(/\/$/, '')),
  boundaryZones: (policy.boundaryZones ?? []).map(globToRegExp),
  ignorePaths: (policy.ignorePaths ?? []).map(globToRegExp),
  fileExtensions: new Set(policy.fileExtensions ?? ['.ts', '.tsx', '.cts', '.mts']),
});

export const matchesNamePattern = (name, pattern) => {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(name);
};

export const matchesAnyNamePattern = (name, patterns) =>
  patterns.some((pattern) => matchesNamePattern(name, pattern));

export const isIgnored = (relPath, policy) => policy.ignorePaths.some((regex) => regex.test(relPath));

export const isBoundary = (relPath, policy) => policy.boundaryZones.some((regex) => regex.test(relPath));

export const isInZone = (relPath, policy) => {
  if (isIgnored(relPath, policy) || isBoundary(relPath, policy)) return false;
  return policy.zones.some((zone) => relPath === zone || relPath.startsWith(`${zone}/`));
};

export const walkFiles = (root, policy) => {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(root, absPath));
      if (!relPath || relPath.startsWith('..') || isIgnored(relPath, policy)) continue;
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && policy.fileExtensions.has(path.extname(entry.name)) && isInZone(relPath, policy)) {
        files.push({ absPath, relPath });
      }
    }
  }

  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

export const getTargets = (root, args, policy) =>
  args.fixtures.length > 0
    ? args.fixtures.map((fixture) => {
        const absPath = path.resolve(root, fixture);
        return { absPath, relPath: toPosix(path.relative(root, absPath)) };
      })
    : walkFiles(root, policy);

export const createSourceFile = (absPath) =>
  ts.createSourceFile(absPath, fs.readFileSync(absPath, 'utf8'), ts.ScriptTarget.Latest, true);

export const getLineAndColumn = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
};

export const createIssue = (sourceFile, relPath, node, rule, message, suggestion) => {
  const position = getLineAndColumn(sourceFile, node);
  return {
    relPath,
    line: position.line,
    column: position.column,
    rule,
    message,
    suggestion,
  };
};

export const formatIssue = (issue) =>
  `${issue.relPath}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}\n  建议: ${issue.suggestion}`;

export const runIssuesMain = ({ title, defaultPolicyPath, compilePolicy, scanFile }) => {
  const args = parseArgs(process.argv.slice(2), { policy: defaultPolicyPath });
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policy = compilePolicy(readJson(policyPath));
  const targets = getTargets(root, args, policy);
  const issues = targets.flatMap((target) => (isInZone(target.relPath, policy) ? scanFile(target, policy) : []));

  if (issues.length === 0) return;

  console.error(`${title} failed:`);
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }
  process.exit(1);
};

export { ts };
