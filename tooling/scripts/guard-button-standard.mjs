#!/usr/bin/env node
// guard:button-standard
// 按钮样式标准守卫：机械执法 docs/ui-button-standard.md §9 的 BTN-001..004 四条可校验规则，
// 豁免登记于 tooling/policies/button-standard.policy.json。
//
// 扫描面与排除项：
// - BTN-001/002/003：policy tsxZones（apps/hub/src、apps/editor/src）下的 .tsx/.ts
//   （.ts 仅承载 buttonVariants({...}) 调用形态扫描）。
//   packages/ui 包内组件实现天然合法，不在扫描面（spec §7）。
// - BTN-004：policy btn004Zone（apps/editor/src）下的 .ts/.tsx/.css。
// - 全规则排除 __tests__ 目录、*.test.* 文件与生成产物目录（dist/dist-static/out 等）。
//
// 规则口径：
// - BTN-001：<Button>（JSX 元素名恰为 Button，不含 Badge/ToggleGroup 等自有组件）的 className
//   含几何覆写 token（h-<数字>、h-[..]、px-[..]、py-[..]、text-[..]、text-2xs、rounded-full、size-*）
//   → 红；policy btn001.exemptions 逐文件登记的 token 放行。响应式前缀（sm:/md:…）剥离后匹配；
//   h-auto / min-h-* / max-h-* / w-* 等布局参与类天然不命中。
// - BTN-002：字面原生 <button> JSX 出现在扫描面 → 红；policy btn002.whitelist 白名单文件放行。
// - BTN-003：<Button> 的 variant=/size= 字面量必须属于 spec §4/§5 枚举
//   （variant: primary/secondary/outline/ghost/link/destructive/ghost-destructive；
//   size: lg/default/sm/2xs/icon/icon-sm/icon-lg）；非字面量（{} 表达式）须 policy btn003.exemptions
//   登记放行。buttonVariants({ variant: ... }) 调用形态同口径扫描。
// - BTN-004：banned 类名/常量（Editor 私有按钮 CSS 类与组件内按钮类常量）出现在 BTN-004 扫描面
//   → 红；policy btn004.exceptions 按名字登记的允许文件放行。扫描前剥离注释（字符串感知、
//   保留行号），类名按词边界匹配（task-cancel 不误伤 task-cancelled-note / task-cancel-contract）。
//
// 家法：AST 提取 className 与 guard:dialog-sizing 同源（支持 cn(...) 组合、三元、模板串）；
// 注释剥离口径与 guard:escape-stack / guard:css-size-tokens 同源。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import ts from "typescript";

const DEFAULT_POLICY = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../policies/button-standard.policy.json",
);

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

const TEST_DIR_SEGMENT = "__tests__";
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;

// spec §4/§5 枚举（docs/ui-button-standard.md 形态语义与尺寸体系）。
const VARIANT_ENUM = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
  "ghost-destructive",
];
const SIZE_ENUM = ["lg", "default", "sm", "2xs", "icon", "icon-sm", "icon-lg"];

const parseArgs = (argv) => {
  const args = { root: process.cwd(), policy: DEFAULT_POLICY };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--root") {
      args.root = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (item === "--policy") {
      args.policy = path.resolve(argv[index + 1] ?? DEFAULT_POLICY);
      index += 1;
    }
  }
  return args;
};

const toPosix = (value) => value.split(path.sep).join("/");

const isTestPath = (relPath) =>
  relPath.split("/").includes(TEST_DIR_SEGMENT) || TEST_FILE_PATTERN.test(relPath);

const isGeneratedFile = (relPath) => /\.d\.[cm]?ts$/.test(relPath) || relPath.endsWith(".d.ts");

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
      if (!relPath || relPath.startsWith("..")) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(absPath);
        continue;
      }
      if (entry.isFile()) files.push({ absPath, relPath });
    }
  }
  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

// zone 成员判定：relPath 位于 zone 内（zone 自身或其子路径）。
const inZone = (relPath, zone) => relPath === zone || relPath.startsWith(`${zone}/`);

// ---------------------------------------------------------------------------
// 注释剥离（BTN-004 用）：字符串感知状态机，注释逐字符置空格、保留行号。
// 字符串内容原样保留（类名以字符串字面量/模板串出现在 className 组合中）。
// ---------------------------------------------------------------------------
const stripComments = (text, { lineComments = true } = {}) => {
  const out = text.split("");
  const n = text.length;
  let mode = "code";
  let i = 0;
  // 模板串 ${} 回栈：frame 记录进入时的花括号深度。
  const templateFrames = [];
  let braceDepth = 0;
  const blank = (index) => {
    if (out[index] !== "\n") out[index] = " ";
  };
  while (i < n) {
    const char = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (mode === "code") {
      if (lineComments && char === "/" && next === "/") {
        blank(i);
        blank(i + 1);
        mode = "line";
        i += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        blank(i);
        blank(i + 1);
        mode = "block";
        i += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        mode = char === "'" ? "sq" : char === '"' ? "dq" : "tpl";
        i += 1;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        i += 1;
        continue;
      }
      if (char === "}") {
        const frame = templateFrames[templateFrames.length - 1];
        if (frame !== undefined && braceDepth === frame.depth) {
          templateFrames.pop();
          mode = "tpl";
          i += 1;
          continue;
        }
        if (braceDepth > 0) braceDepth -= 1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        i += 1;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        mode = "code";
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === quote) {
        mode = "code";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // mode === "tpl"
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") {
      mode = "code";
      i += 1;
      continue;
    }
    if (char === "$" && next === "{") {
      templateFrames.push({ depth: braceDepth });
      mode = "code";
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join("");
};

const lineOfIndex = (text, index) => {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text[position] === "\n") line += 1;
  }
  return line;
};

// ---------------------------------------------------------------------------
// AST 工具（BTN-001/002/003）
// ---------------------------------------------------------------------------
const lineOf = (sourceFile, node) =>
  sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const getAttribute = (openingElement, name) =>
  openingElement.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
  ) ?? null;

// className 取值里的字符串收集：字符串字面量、cn(...) 组合、三元、二元拼接、模板串。
// 标识符（常量引用）记为 "<id:name>" 占位——常量内 token 的静态解析不在本守卫精度内
// （与 guard:dialog-sizing 同精度），仅当占位符不参与 token 匹配。
const collectClassNameStrings = (node) => {
  const strings = [];
  const visit = (current) => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      strings.push(current.text);
      return;
    }
    if (ts.isTemplateExpression(current)) {
      strings.push(current.head.text);
      for (const span of current.templateSpans) {
        visit(span.expression);
        strings.push(span.literal.text);
      }
      return;
    }
    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) visit(argument);
      return;
    }
    if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue);
      visit(current.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(current)) {
      visit(current.left);
      visit(current.right);
      return;
    }
    if (ts.isJsxExpression(current) && current.expression) {
      visit(current.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      visit(current.expression);
      return;
    }
    if (ts.isIdentifier(current)) {
      strings.push(`<id:${current.text}>`);
      return;
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) visit(element);
      return;
    }
  };
  visit(node);
  return strings;
};

const stripResponsivePrefix = (token) => token.replace(/^(?:[a-z]+:)+/, "");

// variant/size 属性分类：{ kind: "literal", value } | { kind: "dynamic", text } | null。
const classifyEnumProp = (attribute) => {
  if (!attribute) return null;
  const initializer = attribute.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return { kind: "literal", value: initializer.text };
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const expression = initializer.expression;
    if (ts.isStringLiteral(expression)) return { kind: "literal", value: expression.text };
    return { kind: "dynamic", text: expression.getText().slice(0, 80) };
  }
  return null;
};

const isButtonElement = (tagName) => {
  const base = tagName.split(".").pop() ?? "";
  return base === "Button";
};

const findButtonFindings = (sourceFile, relPath, policy) => {
  const geometryFindings = [];
  const enumFindings = [];
  const dynamicFindings = [];
  const nativeFindings = [];

  const btn001Exemptions = policy.btn001?.exemptions ?? [];
  const btn002Whitelist = new Set((policy.btn002?.whitelist ?? []).map((entry) => entry.file));
  const btn003Exemptions = new Set((policy.btn003?.exemptions ?? []).map((entry) => entry.file));
  const forbiddenPatterns = (policy.btn001?.forbiddenTokenPatterns ?? []).map(
    (pattern) => new RegExp(pattern),
  );

  const fileGeometryAllowed = btn001Exemptions.find((entry) => entry.file === relPath);
  const geometryAllowedTokens = new Set(fileGeometryAllowed?.allowedTokens ?? []);
  const nativeWhitelisted = btn002Whitelist.has(relPath);
  const dynamicExempted = btn003Exemptions.has(relPath);

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText();
      if (tagName === "button") {
        if (!nativeWhitelisted) {
          nativeFindings.push({ line: lineOf(sourceFile, node) });
        }
      } else if (isButtonElement(tagName)) {
        // BTN-001：className 几何覆写
        const classNameAttr = getAttribute(node, "className");
        if (classNameAttr?.initializer) {
          const strings = collectClassNameStrings(classNameAttr.initializer);
          const hitTokens = new Set();
          for (const text of strings) {
            if (text.startsWith("<id:")) continue;
            for (const rawToken of text.split(/\s+/)) {
              if (!rawToken) continue;
              const token = stripResponsivePrefix(rawToken);
              if (!forbiddenPatterns.some((pattern) => pattern.test(token))) continue;
              if (geometryAllowedTokens.has(token)) continue;
              hitTokens.add(token);
            }
          }
          if (hitTokens.size > 0) {
            geometryFindings.push({ line: lineOf(sourceFile, node), tokens: [...hitTokens] });
          }
        }
        // BTN-003：variant/size 枚举校验
        for (const propName of ["variant", "size"]) {
          const classified = classifyEnumProp(getAttribute(node, propName));
          if (classified === null) continue;
          if (classified.kind === "literal") {
            const allowed = propName === "variant" ? VARIANT_ENUM : SIZE_ENUM;
            if (!allowed.includes(classified.value)) {
              enumFindings.push({
                line: lineOf(sourceFile, node),
                prop: propName,
                value: classified.value,
              });
            }
          } else if (!dynamicExempted) {
            dynamicFindings.push({
              line: lineOf(sourceFile, node),
              prop: propName,
              text: classified.text,
            });
          }
        }
      }
    }
    // BTN-003：buttonVariants({ variant: ... }) 调用形态
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText();
      if (calleeText === "buttonVariants" || calleeText.endsWith(".buttonVariants")) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          for (const property of firstArg.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const propName = property.name.getText();
            if (propName !== "variant" && propName !== "size") continue;
            const value = property.initializer;
            const allowed = propName === "variant" ? VARIANT_ENUM : SIZE_ENUM;
            if (ts.isStringLiteral(value)) {
              if (!allowed.includes(value.text)) {
                enumFindings.push({
                  line: lineOf(sourceFile, property),
                  prop: propName,
                  value: value.text,
                });
              }
            } else if (!dynamicExempted) {
              dynamicFindings.push({
                line: lineOf(sourceFile, property),
                prop: propName,
                text: value.getText().slice(0, 80),
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { geometryFindings, enumFindings, dynamicFindings, nativeFindings };
};

// ---------------------------------------------------------------------------
// BTN-004：banned 类名/常量扫描（注释剥离 + 词边界）
// ---------------------------------------------------------------------------
const bannedNamePattern = (name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$-])${escaped}(?![\\w$-])`, "g");
};

const findBannedFindings = (text, relPath, policy) => {
  const findings = [];
  const exceptions = policy.btn004?.exceptions ?? [];
  for (const name of policy.btn004?.banned ?? []) {
    const exemption = exceptions.find(
      (entry) => (entry.names ?? [entry.name]).includes(name) && entry.files.includes(relPath),
    );
    if (exemption) continue;
    const pattern = bannedNamePattern(name);
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      findings.push({ line: lineOfIndex(text, match.index), name });
      match = pattern.exec(text);
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const run = () => {
  const args = parseArgs(process.argv.slice(2));
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(args.policy, "utf8"));
  } catch (error) {
    console.error(`[guard:button-standard] 无法读取 policy ${args.policy}:`, error instanceof Error ? error.message : error);
    return 1;
  }

  const tsxZones = policy.tsxZones ?? [];
  const btn004Zone = policy.btn004Zone ?? "";
  const ignorePatterns = (policy.ignorePaths ?? []).map(
    (pattern) => new RegExp(`^${pattern.split("*").join(".*")}$`),
  );
  const isIgnoredPath = (relPath) => ignorePatterns.some((regex) => regex.test(relPath));

  const allFiles = walkFiles(args.root).filter((file) => !isIgnoredPath(file.relPath));

  const componentFiles = allFiles.filter(
    (file) =>
      (file.relPath.endsWith(".tsx") || file.relPath.endsWith(".ts")) &&
      !isTestPath(file.relPath) &&
      !isGeneratedFile(file.relPath) &&
      tsxZones.some((zone) => inZone(file.relPath, zone)),
  );
  const btn004Files = allFiles.filter(
    (file) =>
      (file.relPath.endsWith(".ts") ||
        file.relPath.endsWith(".tsx") ||
        file.relPath.endsWith(".css")) &&
      !isTestPath(file.relPath) &&
      !isGeneratedFile(file.relPath) &&
      inZone(file.relPath, btn004Zone),
  );

  const violations = [];
  const scanned = new Set();

  for (const file of componentFiles) {
    scanned.add(file.relPath);
    const sourceText = fs.readFileSync(file.absPath, "utf8");
    const sourceFile = ts.createSourceFile(
      file.relPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found = findButtonFindings(sourceFile, file.relPath, policy);
    for (const finding of found.geometryFindings) {
      violations.push(
        `${file.relPath}:${finding.line} -> BTN-001: <Button> className 几何覆写 token（${finding.tokens.join(", ")}）；几何与字号调整必须走 size prop（docs/ui-button-standard.md §8）`,
      );
    }
    for (const finding of found.nativeFindings) {
      violations.push(
        `${file.relPath}:${finding.line} -> BTN-002: 原生 <button> 未在 policy 白名单登记（docs/ui-button-standard.md §7 三条件）`,
      );
    }
    for (const finding of found.enumFindings) {
      violations.push(
        `${file.relPath}:${finding.line} -> BTN-003: ${finding.prop} 字面量 "${finding.value}" 不属于枚举（docs/ui-button-standard.md §4/§5）`,
      );
    }
    for (const finding of found.dynamicFindings) {
      violations.push(
        `${file.relPath}:${finding.line} -> BTN-003: ${finding.prop} 非字面量 {${finding.text}} 未经 policy 豁免登记（docs/ui-button-standard.md §9）`,
      );
    }
  }

  for (const file of btn004Files) {
    scanned.add(file.relPath);
    const sourceText = fs.readFileSync(file.absPath, "utf8");
    const stripped =
      path.extname(file.relPath) === ".css"
        ? stripComments(sourceText, { lineComments: false })
        : stripComments(sourceText);
    for (const finding of findBannedFindings(stripped, file.relPath, policy)) {
      violations.push(
        `${file.relPath}:${finding.line} -> BTN-004: 私有按钮类/常量 "${finding.name}" 超出 policy 例外登记（只许减少不得新增，docs/ui-button-standard.md §9）`,
      );
    }
  }

  if (violations.length === 0) {
    console.log(`[guard:button-standard] checked ${scanned.size} files.`);
    return 0;
  }

  console.error(
    `[guard:button-standard] ${violations.length} violation(s) in ${scanned.size} files:`,
  );
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "豁免登记见 tooling/policies/button-standard.policy.json；规则出处 docs/ui-button-standard.md §7/§8/§9。",
  );
  return 1;
};

process.exitCode = run();
