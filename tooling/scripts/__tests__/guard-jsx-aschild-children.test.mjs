import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, "tooling/scripts/guard-jsx-aschild-children.mjs");

const runGuard = (fixtureRoot) =>
  spawnSync(process.execPath, [SCRIPT, "--root", fixtureRoot], {
    cwd: ROOT,
    encoding: "utf8",
  });

const writeFixture = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aschild-guard-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return root;
};

test("允许 asChild 包裹单个稳定元素", () => {
  const root = writeFixture({
    "src/ok.tsx": `
      export const Ok = () => (
        <TooltipTrigger asChild>
          <button type="button" />
        </TooltipTrigger>
      );
    `,
  });

  const result = runGuard(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked 1 JSX files/);
});

test("阻止 asChild 单行空白文本形成多个 children", () => {
  const root = writeFixture({
    "src/bad.tsx": `
      export const Bad = () => (
        <TooltipTrigger asChild> <button type="button" /> </TooltipTrigger>
      );
    `,
  });

  const result = runGuard(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /single-line whitespace/);
});

test("阻止 asChild 使用条件表达式作为唯一 child", () => {
  const root = writeFixture({
    "src/bad.tsx": `
      export const Bad = ({ enabled }) => (
        <TooltipTrigger asChild>{enabled && <button type="button" />}</TooltipTrigger>
      );
    `,
  });

  const result = runGuard(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conditional expression/);
});
