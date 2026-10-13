import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = process.cwd();

describe('frontend runtime-source guard', () => {
  it('禁止 modelApiDefaults 静态表回流到 editor 主链', () => {
    const forbiddenPath = path.join(
      REPO_ROOT,
      'apps/editor/src/client/config/modelApiDefaults.ts',
    );
    expect(fs.existsSync(forbiddenPath)).toBe(false);
  });

  it('自动发现生成文件只保留本地 builtin 模型', () => {
    const generatedPath = path.join(
      REPO_ROOT,
      'apps/editor/src/client/config/modelAutoDiscovery.generated.ts',
    );
    const content = fs.readFileSync(generatedPath, 'utf-8');
    expect(content).toContain("edge-detect");
    // 远端模型（当前可用模型包中的真实 model_id）不得进入自动发现生成文件
    expect(content).not.toContain("gemini-3-pro-image");
    expect(content).not.toContain("kling-v3-text2video");
    expect(content).not.toContain("example-new");
  });
});
