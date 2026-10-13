import fs from 'node:fs/promises';
import { collectModelEntries, renderGeneratedContent, GENERATED_FILE } from './model-discovery-utils';

async function main(): Promise<void> {
  const entries = await collectModelEntries();
  const content = renderGeneratedContent(entries);
  await fs.writeFile(GENERATED_FILE, content, 'utf-8');
  console.log(`✅ 生成 modelAutoDiscovery.generated.ts，包含 ${entries.length} 个模型`);
}

main().catch((err) => {
  console.error('❌ 生成自动发现列表失败', err);
  process.exitCode = 1;
});
