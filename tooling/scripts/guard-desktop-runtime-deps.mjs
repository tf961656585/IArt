#!/usr/bin/env node
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..', '..');
const parseRootArg = (argv) => {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex !== -1) return argv[rootIndex + 1] || defaultRepoRoot;
  return argv[0] || defaultRepoRoot;
};
const repoRoot = path.resolve(process.env.IART_GUARD_DESKTOP_RUNTIME_DEPS_ROOT || parseRootArg(process.argv.slice(2)));

const runtimePackages = [
  {
    name: 'Backend',
    packageJson: 'apps/backend/package.json',
    sourceRoots: ['apps/backend/src'],
    requireRootDependency: true,
    allowElectron: false,
  },
  {
    name: 'Desktop Shell',
    packageJson: 'apps/desktop-shell/package.json',
    sourceRoots: ['apps/desktop-shell/src'],
    requireRootDependency: true,
    allowElectron: true,
  },
];

const builtinNames = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, ''), `node:${name.replace(/^node:/, '')}`]),
);

const readJson = (relPath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
const toPosix = (value) => value.split(path.sep).join('/');
const isRelativeOrAbsolute = (specifier) =>
  specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
const isNodeBuiltin = (specifier) => builtinNames.has(specifier) || builtinNames.has(specifier.replace(/^node:/, ''));
const isBareSpecifier = (specifier) => Boolean(specifier) && !isRelativeOrAbsolute(specifier) && !isNodeBuiltin(specifier);
const packageNameFromSpecifier = (specifier) => {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] || specifier;
};

const shouldScanFile = (relPath) => {
  const normalized = toPosix(relPath);
  if (!normalized.endsWith('.cts')) return false;
  if (normalized.endsWith('.d.cts')) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (/(^|\/)[^/]+\.test\.[cm]?tsx?$/.test(normalized)) return false;
  if (normalized.includes('/dist/') || normalized.includes('/dist-static/') || normalized.includes('/node_modules/')) {
    return false;
  }
  return true;
};

const walkSourceFiles = (absRoot) => {
  const files = [];
  const stack = [absRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || !fs.existsSync(dir)) continue;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absPath = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(repoRoot, absPath));
      if (entry.isDirectory()) {
        if (!['dist', 'dist-static', 'node_modules'].includes(entry.name)) stack.push(absPath);
        continue;
      }
      if (entry.isFile() && shouldScanFile(relPath)) files.push({ absPath, relPath });
    }
  }

  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

const getStringLiteral = (node) => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

const getCallExpressionName = (expression) => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const base = ts.isIdentifier(expression.expression) ? expression.expression.text : '';
    return base ? `${base}.${expression.name.text}` : expression.name.text;
  }
  return '';
};

const collectRuntimeSpecifiers = ({ absPath, relPath }) => {
  const sourceFile = ts.createSourceFile(
    absPath,
    fs.readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const requireAliases = new Set(['require']);
  const refs = [];

  const addRef = (specifier, node, kind) => {
    if (!isBareSpecifier(specifier)) return;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    refs.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      relPath,
      line: pos.line + 1,
      column: pos.character + 1,
      kind,
    });
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true &&
      getStringLiteral(node.moduleSpecifier)
    ) {
      addRef(getStringLiteral(node.moduleSpecifier), node.moduleSpecifier, 'import');
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = getStringLiteral(node.moduleReference.expression);
      if (specifier) addRef(specifier, node.moduleReference.expression, 'import-require');
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      getCallExpressionName(node.initializer.expression) === 'createRequire'
    ) {
      requireAliases.add(node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const callName = getCallExpressionName(node.expression);
      const firstArg = node.arguments[0];
      const specifier = getStringLiteral(firstArg);
      if (specifier && (requireAliases.has(callName) || callName === 'module.require')) {
        addRef(specifier, firstArg, callName === 'module.require' ? 'module-require' : 'require');
      }
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addRef(specifier, firstArg, 'dynamic-import');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return refs;
};

const hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record ?? {}, key);
const getDependencyLocation = (pkg, packageName) => {
  if (hasOwn(pkg.dependencies, packageName)) return 'dependencies';
  if (hasOwn(pkg.devDependencies, packageName)) return 'devDependencies';
  if (hasOwn(pkg.optionalDependencies, packageName)) return 'optionalDependencies';
  if (hasOwn(pkg.peerDependencies, packageName)) return 'peerDependencies';
  return null;
};

const createIssueKey = (runtimeName, packageName) => `${runtimeName}\0${packageName}`;

const addIssue = (issues, runtimePkg, packageName, refs, messages, fixes) => {
  const key = createIssueKey(runtimePkg.name, packageName);
  const existing = issues.get(key);
  if (existing) {
    for (const message of messages) existing.messages.add(message);
    for (const fix of fixes) existing.fixes.add(fix);
    return;
  }
  issues.set(key, {
    runtimeName: runtimePkg.name,
    packageName,
    refs,
    messages: new Set(messages),
    fixes: new Set(fixes),
  });
};

const scanRuntimePackages = () => {
  const rootPackageJson = readJson('package.json');
  const issues = new Map();

  for (const runtimePkg of runtimePackages) {
    const packageJson = readJson(runtimePkg.packageJson);
    const refsByPackage = new Map();

    for (const sourceRoot of runtimePkg.sourceRoots) {
      const absRoot = path.join(repoRoot, sourceRoot);
      for (const file of walkSourceFiles(absRoot)) {
        for (const ref of collectRuntimeSpecifiers(file)) {
          const refs = refsByPackage.get(ref.packageName) ?? [];
          refs.push(ref);
          refsByPackage.set(ref.packageName, refs);
        }
      }
    }

    for (const [packageName, refs] of refsByPackage) {
      if (packageName === 'electron') {
        if (!runtimePkg.allowElectron) {
          addIssue(
            issues,
            runtimePkg,
            packageName,
            refs,
            ['Backend packaged runtime must not import electron directly.'],
            [`Remove "${packageName}" from ${runtimePkg.name} runtime source or move the behavior to Desktop Shell.`],
          );
        }
        continue;
      }

      const ownerLocation = getDependencyLocation(packageJson, packageName);
      const messages = [];
      const fixes = [];
      if (ownerLocation !== 'dependencies') {
        if (ownerLocation) {
          messages.push(`"${packageName}" is declared in ${runtimePkg.packageJson} ${ownerLocation}, not dependencies.`);
        } else {
          messages.push(`missing ${runtimePkg.packageJson} dependencies.${packageName}`);
        }
        fixes.push(`pnpm add --filter ${packageJson.name} ${packageName}`);
      }

      if (runtimePkg.requireRootDependency) {
        const rootLocation = getDependencyLocation(rootPackageJson, packageName);
        if (rootLocation !== 'dependencies') {
          if (rootLocation) {
            messages.push(`"${packageName}" is declared in root package.json ${rootLocation}, not dependencies.`);
          } else {
            messages.push(`missing root package.json dependencies.${packageName} for Electron Builder packaged runtime`);
          }
          fixes.push(`pnpm add -w ${packageName}`);
        }
      }

      if (messages.length > 0) addIssue(issues, runtimePkg, packageName, refs, messages, fixes);
    }
  }

  return [...issues.values()].sort((left, right) =>
    `${left.runtimeName}:${left.packageName}`.localeCompare(`${right.runtimeName}:${right.packageName}`),
  );
};

const formatIssue = (issue) => {
  const refLines = issue.refs
    .slice(0, 6)
    .map((ref) => `  - ${ref.specifier} via ${ref.kind} at ${ref.relPath}:${ref.line}:${ref.column}`);
  if (issue.refs.length > 6) refLines.push(`  - ... ${issue.refs.length - 6} more reference(s)`);

  return [
    `[guard:desktop-runtime-deps] ${issue.runtimeName} imports "${issue.packageName}" in packaged runtime source`,
    ...refLines,
    ...[...issue.messages].map((message) => `  - ${message}`),
    '  Fix:',
    ...[...issue.fixes].map((fix) => `    ${fix}`),
  ].join('\n');
};

const issues = scanRuntimePackages();
if (issues.length > 0) {
  console.error(`Desktop runtime dependency closure guard failed (${issues.length} issue(s)):\n`);
  console.error(issues.map(formatIssue).join('\n\n'));
  process.exit(1);
}
