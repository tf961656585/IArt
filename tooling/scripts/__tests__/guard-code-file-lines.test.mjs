import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, "tooling/scripts/guard-code-file-lines.mjs");

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGate = (root, maxLines = 600) =>
  spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--max-lines", String(maxLines)],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

test("code files at the line limit pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-lines-"));
  writeFile(
    path.join(root, "src", "ok.ts"),
    `${"const value = 1;\n".repeat(600)}`,
  );

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked 1 code files/);
});

test("code files over the line limit fail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-lines-"));
  writeFile(
    path.join(root, "src", "too-large.tsx"),
    `${"const value = 1;\n".repeat(601)}`,
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /too-large\.tsx: 601 lines/);
});

test("generated files and build outputs do not enter the line gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-lines-"));
  writeFile(
    path.join(root, "src", "types.d.ts"),
    `${"declare const value: string;\n".repeat(800)}`,
  );
  writeFile(
    path.join(root, "src", "model.generated.ts"),
    `// @generated\n${"export const value = 1;\n".repeat(800)}`,
  );
  writeFile(
    path.join(root, "dist", "bundle.js"),
    `${"const value = 1;\n".repeat(800)}`,
  );

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked 0 code files/);
});

test("generated-looking source without a generated marker still enters the line gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-lines-"));
  writeFile(
    path.join(root, "src", "manual.generated.ts"),
    `${"export const value = 1;\n".repeat(601)}`,
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manual\.generated\.ts: 601 lines/);
});

test("eslint max-lines disable comments are rejected as line gate bypasses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-lines-"));
  const ruleName = "max" + "-lines";
  writeFile(
    path.join(root, "src", "bypass.ts"),
    `/* eslint-disable ${ruleName} */\nexport const value = 1;\n`,
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /bypass\.ts: Do not disable the max-lines lint gate/,
  );
});
