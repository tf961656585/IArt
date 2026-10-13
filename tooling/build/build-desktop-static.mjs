import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: rootDir,
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
};

try {
  run("pnpm", ["--filter", "@iart/contracts", "build"]);
  run("pnpm", ["--filter", "@iart/ui", "build"]);
  run("pnpm", ["--filter", "@iart/model-asset-runtime", "build"]);
  run("pnpm", ["--filter", "@iart/domain", "build"]);
  run("pnpm", ["--filter", "@iart/backend-sdk", "build"]);
  run("node", ["./tooling/build/build-hub-static.mjs"]);
  run("node", ["./tooling/build/build-editor-static.mjs"], {
    ...process.env,
    IART_SKIP_WORKSPACE_PREREQS: "1",
  });
} catch (error) {
  console.error("[build-desktop-static] 失败：", error);
  process.exitCode = 1;
}
