import { runBuildModelAssetPackagesCli } from './model-asset-packages/cli';

runBuildModelAssetPackagesCli().catch((error) => {
  console.error('❌ 模型包打包失败');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
