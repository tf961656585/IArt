import fs from 'node:fs/promises';
import { collectModelEntries, findModelDirsMissingIndex, renderGeneratedContent, GENERATED_FILE } from './model-discovery-utils';

async function main(): Promise<void> {
  const missing = await findModelDirsMissingIndex();
  if (missing.length > 0) {
    console.error('❌ 以下模型目录缺少 index.ts（请补充或移除无效目录）:');
    missing.forEach((dir) => console.error(` - ${dir}`));
    process.exitCode = 1;
    return;
  }

  const entries = await collectModelEntries();
  const expected = renderGeneratedContent(entries).trim();

  let actual = '';
  try {
    actual = (await fs.readFile(GENERATED_FILE, 'utf-8')).trim();
  } catch {
    console.error('❌ 未找到生成文件 modelAutoDiscovery.generated.ts，请运行 pnpm generate:model-discovery');
    process.exitCode = 1;
    return;
  }

  if (expected !== actual) {
    console.error('❌ modelAutoDiscovery.generated.ts 与当前模型目录不一致，请运行 pnpm generate:model-discovery');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 模型索引校验通过，共 ${entries.length} 个模型`);
}

main().catch((err) => {
  console.error('❌ 校验失败', err);
  process.exitCode = 1;
});
