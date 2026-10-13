import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      "**/.next/**",
      "**/.cache/**",
      "**/out/**",
      "**/build/**",
      "**/dist/**",
      "dist-desktop/**",
      ".publish/**",
      ".skill-dist/**",
      "apps/editor/dist-static/**",
      "apps/hub/dist-static/**",
      "next-env.d.ts",
      "**/next-env.d.ts",
      "**/coverage/**",
      "_templates/**",
      "apps/backend/native-modules/**",
      "**/*.d.cts",
      "**/*.cjs",
      "**/*.cjs.map",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.cts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
      },
    },
  },
  ...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
    "next/core-web-vitals",
    "next/typescript",
  ),
  {
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": true, "ts-expect-error": true, "ts-check": false, "ts-nocheck": true }],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "TSAsExpression > TSAsExpression",
          "message": "禁止双重类型断言 (as X as Y)。提取共享类型或使用类型守卫。"
        },
        {
          "selector": "TSInterfaceDeclaration[extends.length>0] TSExpressionWithTypeArguments[expression.name='Record']",
          "message": "稳定业务类型禁止继承 Record。开放结构必须使用明确的 Raw/External/Dynamic/*Map 类型承载。"
        },
        {
          "selector": "TSIndexSignature TSTypeAnnotation > TSUnknownKeyword",
          "message": "禁止裸 string -> unknown 索引签名。固定业务字段应写成显式类型；开放 map 交给 harness 边界配置裁定。"
        }
      ],
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-unused-expressions": ["error", {
        allowShortCircuit: true,
        allowTaggedTemplates: true,
        allowTernary: true,
      }],
      "max-lines": [
        "error",
        { max: 1000, skipBlankLines: false, skipComments: false },
      ],
    },
    settings: {
      next: {
        rootDir: ["apps/editor/", "apps/hub/"],
      },
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.cts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  {
    files: ["tooling/scripts/**/*.cjs", "**/*.cts"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 原型页面 JS 是 classic script（无构建链、file:// 直开），跨文件靠全局词法环境共享；
    // 按 script 源类型解析才能如实消费 /* global */（含 :writable）与 /* exported */ 指令。
    // next 预设注入的 ecmaFeatures.globalReturn 会改变 eslint-scope 全局作用域形态、
    // 使 /* exported */ 失效，此处显式关闭（原型顶层无 return，语义无损）。
    // TS 版 no-unused-vars 不支持 /* exported */，纯 JS 上以基础规则等价替换（同级 warn + 同忽略模式）。
    files: ["prototypes/**/*.js"],
    languageOptions: {
      sourceType: "script",
      parserOptions: { ecmaFeatures: { globalReturn: false } },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
];

export default eslintConfig;
