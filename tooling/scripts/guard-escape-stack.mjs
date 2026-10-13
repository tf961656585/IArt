#!/usr/bin/env node
// guard:escape-stack
// 浮层 Esc 栈守卫：阻断业务面自行判定/处理 Escape 键，Esc 必须经浮层栈分发。
// spec: docs/editor/浮层堆栈管理.md「守卫边界」节。
// 事实源：packages/ui/src/overlay-stack（OverlayEscapeDispatcher + useOverlayLayer）。
//
// 阻断模式（命中任一即报红）：
// 1. Escape 字符串字面量处于比较语境：`event.key === 'Escape'`、`event.key !== 'Escape'`、
//    `event.code === 'Escape'`、`event.key.toLowerCase() === 'escape'`（字面量大小写不敏感）、
//    字面量在左的 `'Escape' === event.key`、以及 switch 标签 `case 'Escape':`（同为比较语境）。
// 2. keyCode 与 27 的比较：`event.keyCode === 27`、`27 === event.keyCode`。
// 3. Escape 专有回调标识符：`onEscape`、`onEscapeKeyDown`（props 透传或回调声明）。
//
// 判定逻辑与误报控制（grep 级静态扫描，与 guard-elevation-z 同水准）：
// - 模式收窄：只阻断「比较语境」与「Escape 专有标识符」，不阻断 Escape 字面量的其他出现——
//   注释、日志/展示字符串（`console.log('Escape pressed')`）、类型字面量（`type Key = 'Escape' | 'Enter'`）
//   都不含相邻比较运算符，天然不命中。
// - 注释剥离：扫描前把 `//` 行注释与 `/* */` 块注释置空（字符串感知、保留行号），
//   迁移说明注释里引用的旧写法与被注释掉的旧实现对守卫不可见（同 guard:css-undefined-vars 的注释剥离口径）。
// - 行内豁免：行内含 `guard-escape-stack-exempt` 标记时跳过该行（临时遗留专用；spec 要求
//   在标记处附注释说明原因与消除条件，该要求在 review 把关，不做机械校验）。
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = process.cwd();
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

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

// spec 声明的扫描根：Editor / Hub / @iart/ui 业务面。
const SCAN_PATH_PREFIXES = [
  "apps/editor/src/",
  "apps/hub/src/",
  "packages/ui/src/",
];

// 分发器事实源（栈自身必须读 Escape）、设计层原型（独立坐标系，不进运行时构建）、
// 守卫自身与其自测夹具。
const EXEMPT_PATH_PREFIXES = [
  "packages/ui/src/overlay-stack/",
  "prototypes/",
  "tooling/scripts/",
];

const INLINE_EXEMPT_MARKER = "guard-escape-stack-exempt";

const TEST_PATH_SEGMENT = "__tests__";
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;

const COMPARISON_OPERATOR = "(?:===?|!==?)";
// Escape 字面量：'Escape' / "Escape" / 'escape' / 'ESCAPE'（守卫不区分大小写写法）。
const ESCAPE_LITERAL = `["'][Ee][Ss][Cc][Aa][Pp][Ee]["']`;

// 1. Escape 字面量比较语境（运算符任一侧，或 switch case 标签）。
const ESCAPE_COMPARISON_PATTERN = new RegExp(
  `${COMPARISON_OPERATOR}\\s*${ESCAPE_LITERAL}|${ESCAPE_LITERAL}\\s*${COMPARISON_OPERATOR}|\\bcase\\s+${ESCAPE_LITERAL}`,
);

// 2. keyCode 与 27 的比较：`event.keyCode === 27` 与 `27 === event.keyCode` 两个方向。
const KEY_CODE_27_PATTERN = new RegExp(
  `\\bkeyCode\\s*${COMPARISON_OPERATOR}\\s*27\\b|\\b27\\s*${COMPARISON_OPERATOR}\\s*(?:[A-Za-z_$][\\w$]*\\.)*keyCode\\b`,
);

// 3. Escape 专有回调标识符（onEscape / onEscapeKeyDown ...）。
// 大小写敏感：`closeOnEscape` 是层配置字段（合法），不在此模式内。
const ON_ESCAPE_PATTERN = /\bonEscape[A-Za-z0-9_$]*\b/;

const SCAN_PATTERNS = [
  { mode: "Escape 字面量比较", pattern: ESCAPE_COMPARISON_PATTERN },
  { mode: "keyCode 27 判定", pattern: KEY_CODE_27_PATTERN },
  { mode: "onEscape* 回调", pattern: ON_ESCAPE_PATTERN },
];

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
  relPath.split("/").some((segment) => IGNORED_DIRS.has(segment));

const isScanTarget = (relPath) =>
  SCAN_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix));

const isExempt = (relPath) =>
  EXEMPT_PATH_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(prefix),
  );

const isTestPath = (relPath) =>
  relPath.split("/").includes(TEST_PATH_SEGMENT) || TEST_FILE_PATTERN.test(relPath);

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
        isScanTarget(relPath) &&
        !isExempt(relPath) &&
        !isTestPath(relPath)
      ) {
        files.push({ absPath, relPath });
      }
    }
  }

  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

// 注释剥离：`//` 行注释与 `/* */` 块注释替换为同长度空白，保留换行与行号。
// 字符串感知：单/双引号与模板字符串内部不剥离，避免把 URL 中的 `//` 当注释起始
// （截断行会让关键字面量比较漏检）。
const stripComments = (text) => {
  let result = "";
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\n") {
      inLineComment = false;
      result += char;
      continue;
    }
    if (inLineComment) {
      result += " ";
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        index += 1;
        continue;
      }
      result += " ";
      continue;
    }
    if (quote) {
      result += char;
      if (char === "\\") {
        if (next !== undefined && next !== "\n") {
          result += next;
          index += 1;
        }
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    // JSX/文案里的所有格撇号（`It's`）夹在字母之间，不作为字符串起始。
    if (
      char === "'" &&
      /[\w$]/.test(text[index - 1] ?? "") &&
      /[\w$]/.test(next ?? "")
    ) {
      result += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      continue;
    }
    result += char;
  }

  return result;
};

const scanText = (relPath, text) => {
  const findings = [];
  const rawLines = text.split("\n");
  const codeLines = stripComments(text).split("\n");

  for (let index = 0; index < rawLines.length; index += 1) {
    // 行内豁免按原始行判定：标记通常写在行尾注释里，注释剥离后不可见。
    if (rawLines[index].includes(INLINE_EXEMPT_MARKER)) continue;

    const codeLine = codeLines[index] ?? "";
    for (const { mode, pattern } of SCAN_PATTERNS) {
      const match = codeLine.match(pattern);
      if (!match) continue;
      findings.push({
        relPath,
        line: index + 1,
        mode,
        token: match[0].trim(),
      });
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
    findings.push(...scanText(file.relPath, text));
  }

  if (findings.length === 0) {
    console.log(
      `[guard:escape-stack] checked ${files.length} files (overlay-stack dispatcher exempted).`,
    );
    return 0;
  }

  console.error(
    `[guard:escape-stack] ${findings.length} 处绕过 Esc 栈的 Escape 键判定/处理。Esc 只能由 OverlayEscapeDispatcher 分发，浮层经 useOverlayLayer 注册入栈。`,
  );
  for (const finding of findings) {
    console.error(
      `- ${finding.relPath}:${finding.line} -> ${finding.mode}：${finding.token}`,
    );
  }
  console.error(
    "Escape handling must go through the overlay stack (packages/ui/src/overlay-stack). See docs/editor/浮层堆栈管理.md.",
  );
  return 1;
};

process.exitCode = run();
