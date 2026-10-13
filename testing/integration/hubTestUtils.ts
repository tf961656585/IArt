// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

export const loadHubSourceHtml = (): string => {
  const rootDir = process.cwd();
  const htmlPath = path.join(rootDir, "apps/hub/dist-static/index.html");
  return fs.readFileSync(htmlPath, "utf8");
};

export const loadHubSrcFile = (relativePath: string): string => {
  const rootDir = process.cwd();
  return fs.readFileSync(path.join(rootDir, "apps/hub", relativePath), "utf8");
};

export const loadHubHtml = (): string => {
  const rootDir = process.cwd();
  const html = loadHubSourceHtml();
  const inlineScript = (sourceHtml: string, scriptName: string) => {
    const externalScriptTag = `<script src="./${scriptName}"></script>`;
    if (!sourceHtml.includes(externalScriptTag)) {
      return sourceHtml;
    }

    const builtScriptPath = path.join(
      rootDir,
      "apps/hub/dist-static",
      scriptName,
    );
    if (!fs.existsSync(builtScriptPath)) {
      throw new Error(`Missing built Hub script: ${builtScriptPath}`);
    }

    const builtScript = fs
      .readFileSync(builtScriptPath, "utf8")
      .replaceAll("</script", "<\\/script");
    return sourceHtml.replace(
      externalScriptTag,
      () => `<script>\n${builtScript}\n</script>`,
    );
  };

  return inlineScript(html, "hub-main.js");
};
