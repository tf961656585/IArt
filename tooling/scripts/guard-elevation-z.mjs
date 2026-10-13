#!/usr/bin/env node
// guard:elevation-z
// 海拔层级守卫：禁止业务层书写数字 z-index 散值，浮层海拔必须消费语义令牌。
// spec: docs/editor/elevation-z-model.md「层级阶梯」「守卫边界」节。
// 令牌定义在 packages/ui/src/elevation.css（--z-index-* 命名空间），
// 消费口径：Tailwind className 用 z-dock / z-modal 等语义类，
// 原生 CSS 用 var(--z-index-dock)。
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = process.cwd();
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

const IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "dist-desktop",
  "dist-static",
  "node_modules",
  "out",
]);

// 令牌定义事实源、守卫自测夹具与设计原型豁免。prototypes/ 是设计层
// 事实源（独立原型坐标系，数字海拔是原型稿的一部分，不进运行时构建）。
const EXEMPT_PATH_PREFIXES = [
  "packages/ui/src/elevation.css",
  "prototypes/",
  "tooling/scripts/__tests__/",
  "tooling/scripts/guard-elevation-z.mjs",
];

// 局部叠层白名单：z-0/z-10/z-20/-z-10 只在节点/卡片内部表达内部叠层，
// 被 ReactFlow 节点 transform 堆叠上下文包裹、不参与视图级海拔排序，
// 允许直接书写（spec「守卫边界」节）。
const LOCAL_INNER_Z_CLASSES = new Set(["z-0", "z-10", "z-20", "-z-10"]);

const parseArgs = (argv) => {
  const args = { root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--root") {
      args.root = path.resolve(argv[index + 1] ?? "");
      index += 1;
    }
  }
  return args;
};

const toPosix = (value) => value.split(path.sep).join("/");

const shouldIgnorePath = (relPath) =>
  IGNORED_DIRS.has(relPath.split("/")[0]) ||
  relPath.split("/").some((segment) => IGNORED_DIRS.has(segment));

const isExempt = (relPath) =>
  EXEMPT_PATH_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(prefix),
  );

const walkFiles = (root) => {
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
      if (!relPath || relPath.startsWith("..") || shouldIgnorePath(relPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }

      if (
        entry.isFile() &&
        SCAN_EXTENSIONS.has(path.extname(relPath)) &&
        !isExempt(relPath)
      ) {
        files.push({ absPath, relPath });
      }
    }
  }

  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

// className 中的数字 z 散值：z-[120]、z-50 等。前置边界含引号/花括号
// （className 字符串首 token 无前导空白）；语义令牌（z-dock 等）天然不含
// 数字段，不会被误匹配。
const TAILWIND_Z_PATTERN = new RegExp(
  `(?:^|[\\s"'\\\`{}=,:])(-?z-(?:\\[[^\\]]*\\]|\\d+))(?=[\\s"'\\\`{}=,;:]|$)`,
  "g",
);

// 原生 CSS 中的数字 z-index：z-index: 50 / z-index:1300 / zIndex: 5（内联 style）。
// 允许：var(--z-index-*)、-1（xyflow 沉底惯例，画布坐标系内部）、
// 与少数节点内部小整数（≤6，同局部叠层白名单语义）。
const CSS_Z_INDEX_PATTERN = /z-index\s*:\s*([^;}\n]+)/g;
const INLINE_STYLE_Z_PATTERN = /(?:style\s*=\s*\{\s*|Object\.assign\(\s*\{\s*)?zIndex\s*:\s*([^,\n}]+)/g;

// TS 类型上下文误报排除：接口成员/类型字面量里的 `zIndex: number` 是
// 字段类型声明，不是样式值。
const isTypeAnnotationValue = (rawValue) => /^\s*(number|string)\s*;?\s*$/.test(rawValue);

const classifyCssValue = (rawValue) => {
  const value = rawValue.trim();
  if (/^var\(--z-index-[a-z0-9-]+\)$/.test(value)) return null;
  // 具名常量引用（如 MARQUEE_Z_INDEX）与计算表达式（如 nodeIndex.get(id) ?? 0）：
  // 常量消费方自行锚定 token 值；表达式多为画布坐标系内部排序（非 CSS 海拔），
  // 静态不可判则放行。守卫只阻断裸数字字面量。
  if (!/^-?\d+$/.test(value)) return null;
  const numeric = Number(value);
  if (numeric === -1) return null; // xyflow 沉底惯例
  if (numeric >= 0 && numeric <= 6) return null; // 节点内部叠层
  return `z-index: ${value}`;
};

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const scanTsContent = (relPath, text) => {
  const findings = [];
  for (const match of text.matchAll(TAILWIND_Z_PATTERN)) {
    const token = match[1];
    if (LOCAL_INNER_Z_CLASSES.has(token)) continue;
    findings.push({ relPath, line: lineOf(text, match.index), token });
  }
  // 内联 style 中的 zIndex 数字（TS/TSX 里的对象字面量）。
  // 允许两类画布坐标系内部值（非视图海拔，spec「守卫边界」节）：
  // - 具名常量/表达式引用（非纯数字字面量）——消费方自行锚定 token 值；
  // - 0——ReactFlow 节点投影默认层。
  for (const match of text.matchAll(INLINE_STYLE_Z_PATTERN)) {
    if (isTypeAnnotationValue(match[1])) continue;
    const verdict = classifyCssValue(match[1]);
    if (verdict) {
      findings.push({
        relPath,
        line: lineOf(text, match.index),
        token: `style { ${verdict} }`,
      });
    }
  }
  return findings;
};

const scanCssContent = (relPath, text) => {
  const findings = [];
  for (const match of text.matchAll(CSS_Z_INDEX_PATTERN)) {
    const verdict = classifyCssValue(match[1]);
    if (verdict) {
      findings.push({ relPath, line: lineOf(text, match.index), token: verdict });
    }
  }
  return findings;
};

const run = () => {
  const args = parseArgs(process.argv.slice(2));
  const files = walkFiles(args.root);
  const findings = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.absPath, "utf8");
    } catch {
      continue;
    }
    // 行级豁免：行内含 guard-elevation-z-exempt 标记时跳过。
    const lines = text.split("\n");
    const kept = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/guard-elevation-z-exempt/.test(line)) continue;
      kept.push(line);
    }
    if (kept.length === lines.length) {
      findings.push(
        ...(file.relPath.endsWith(".css")
          ? scanCssContent(file.relPath, text)
          : scanTsContent(file.relPath, text)),
      );
    } else {
      const filtered = kept.join("\n");
      findings.push(
        ...(file.relPath.endsWith(".css")
          ? scanCssContent(file.relPath, filtered)
          : scanTsContent(file.relPath, filtered)),
      );
    }
  }

  if (findings.length === 0) {
    console.log(
      `[guard:elevation-z] checked ${files.length} files (elevation.css exempted).`,
    );
    return 0;
  }

  console.error(
    `[guard:elevation-z] ${findings.length} 处数字 z-index 散值，浮层海拔必须消费语义令牌。`,
  );
  for (const finding of findings) {
    console.error(`- ${finding.relPath}:${finding.line} -> ${finding.token}`);
  }
  console.error(
    "Elevation must use z-dock/z-modal/... tokens (packages/ui/src/elevation.css). See docs/editor/elevation-z-model.md.",
  );
  return 1;
};

process.exitCode = run();
