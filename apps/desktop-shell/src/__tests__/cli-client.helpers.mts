// CLI 客户端测试共享装配（编译产物加载器 + 夹具 + 注入响应构造），不含断言。
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;
const parserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;

export type CliClientRunResult = { exitCode: number; stdout: string; stderr: string };

export type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: { discoveryFilePath?: string; fetchImpl?: typeof fetch },
  ) => Promise<CliClientRunResult>;
};

export type ParserModule = {
  parseCliArgs: (argv: readonly string[]) =>
    | { ok: true; request: unknown; json: boolean }
    | { ok: false; reason?: string; message?: string; topic?: { kind: string } };
  renderCliHelpText: (topic: { kind: "top" } | { kind: "noun"; noun: string } | { kind: "command"; phrase: string }) => string;
  CLI_USAGE_TEXT: string;
};

export type ServiceHandle = {
  port: number;
  discoveryFilePath: string;
  stop: () => Promise<void>;
  getCommandLog: () => readonly unknown[];
};

export type ServiceModule = {
  startCliControlService: (options?: {
    port?: number;
    discoveryFilePath?: string;
    readProjects?: () => readonly unknown[];
    version?: string;
  }) => Promise<ServiceHandle>;
};

export const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;
export const loadParserModule = (): ParserModule => requireDesktop(parserEntry) as ParserModule;
export const loadServiceModule = (): ServiceModule => requireDesktop(serviceEntry) as ServiceModule;

export type FixtureEntry = {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt: number;
};

export const fixtureProjects: FixtureEntry[] = [
  { nodeGraphId: "ng-1", name: "演示项目", path: "/tmp/demo.iartproj", createdAt: 1, savedAt: 2, lastOpenedAt: 1700000000000 },
];

export const writeDiscoveryFile = (filePath: string, content: Record<string, unknown>): void => {
  writeFileSync(filePath, JSON.stringify(content, null, 2), { encoding: "utf-8", mode: 0o600 });
};

export const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
