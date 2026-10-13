import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type RootPackageJson = {
  pnpm: {
    patchedDependencies: Record<string, string> | undefined;
  } | undefined;
};

const repoRoot = process.cwd();

const readText = (relativePath: string): string => {
  return readFileSync(join(repoRoot, relativePath), "utf8");
};

describe("@xyflow/react resize observer patch", () => {
  it("registers and applies the zero-delta guard patch", () => {
    const packageJson = JSON.parse(
      readText("package.json"),
    ) as RootPackageJson;
    const patchedDependencies =
      packageJson.pnpm !== undefined &&
      packageJson.pnpm !== null &&
      packageJson.pnpm.patchedDependencies !== undefined &&
      packageJson.pnpm.patchedDependencies !== null
        ? packageJson.pnpm.patchedDependencies
        : {};

    expect(patchedDependencies["@xyflow/react@12.10.0"]).toBe(
      "patches/@xyflow__react@12.10.0.patch",
    );

    const patchText = readText("patches/@xyflow__react@12.10.0.patch");
    expect(patchText).toContain(
      "const lastDimensionsByElement = new WeakMap();",
    );
    expect(patchText).toContain("previousDimensions.width === width");
    expect(patchText).toContain("previousDimensions.height === height");
    expect(patchText).toContain("if (updates.size > 0) {");
    expect(patchText).toContain("dist/esm/index.mjs");

    const installedModuleText = readText(
      "node_modules/@xyflow/react/dist/esm/index.mjs",
    );
    expect(installedModuleText).toContain(
      "const lastDimensionsByElement = new WeakMap();",
    );
    expect(installedModuleText).toContain("if (updates.size > 0) {");
  });
});
