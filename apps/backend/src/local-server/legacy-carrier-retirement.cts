import { listCustomChatModels } from './provider-connection/custom-chat-model-store.cts';
import { listCustomGenerationModels } from './provider-connection/custom-generation-model-store.cts';
import { retireResidualDeployments } from './provider-connection/deployment-to-record-migration.cts';
import * as loggingModule from './logging.cts';

/**
 * 退役载体 `ModelDeployment` 的收尾：**装载两族模型记录 → 归档并丢弃旧接入文件**。
 *
 * 为什么要一个显式的启动步骤，而不是把收尾挂在某个 store 的装载路径上：
 *
 * 旧接入文件里同时可能有「对话链的 v1 声明接入」和「生成链的接入」。两段 v1 迁移各自的完成判据
 * 都是「我并掉的那几条不在了」，但它们分属两个 store，装载顺序不确定。若把「归档并删除整份旧
 * 文件」挂在其中任意一个的装载路径上，先被装载的那一方就会把另一方还没搬运的数据一起丢掉
 * （v1 对话声明反查不到自己的接入 → 被当孤儿丢弃，用户模型凭空消失）。
 *
 * 因此收尾被提成一个**顺序确定的一次性步骤**（2026-10-19 原子换轨的最后一步，spec 03 §11）：
 * 1. 先装载对话记录 store：触发它的 v1→v3 声明合并（需要旧接入作为反查源）；
 * 2. 再装载生成记录 store：触发 v1→v3 声明合并 + 「旧接入 → 生成记录」换算；
 * 3. 两段搬运都结束后，才归档并丢弃旧文件里的残留条目。
 *
 * 顺序不可颠倒：1、2 都只需要**读**旧文件，3 是唯一的破坏性动作。挂载点在 Runtime Backend
 * 启动路径上（`main.cts` 的 listen 之前），因此「任何模型被执行、被投影或被视为可提交之前，
 * 换轨已完成」这条硬约束由进程启动顺序保证，不依赖请求先打到哪个端点。
 *
 * 幂等：记录文件已是当前形状时 1、2 是纯读取；旧文件不在时 3 是零操作。二次启动不做任何写入。
 * 返回本次归档掉的残留接入条数（0 = 没有残留）。
 */
const retireLegacyModelDeploymentCarrier = (): number => {
  // 1、2：让两段 v1 迁移与「旧接入 → 记录」换算各自完成（纯读取，记录落盘由 store 自己负责）。
  listCustomChatModels();
  listCustomGenerationModels();
  // 3：残留（无族 model_id / 与用户记录同名的冲突条目）归档后丢弃旧文件。
  const archived = retireResidualDeployments();
  loggingModule.logDebug('[legacy-carrier-retirement] retirement step finished', { archived });
  return archived;
};

export { retireLegacyModelDeploymentCarrier };
