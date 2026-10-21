---
name: iart-cli
description: |
  通过 iart 命令行驱动正在运行的 IARTStudio 桌面应用（资产上下文画布创作空间）：
  打开/创建项目、提交生成并把产物落进画布、建组/加成员/移出成员、整理布局、查询与等待生成任务。
  当用户提到「IARTStudio」「iArtStudio」「iart 命令」「在软件里生成」「把图放进画布」
  「打开项目」「建个组」「整理布局」「查一下生成任务」等意图时触发。
  前提：IARTStudio 应用正在运行（CLI 不会自动启动应用）；Agent 的每一步操作都在应用
  画布上可见、可撤销。若用户只想要图片文件、不涉及画布与项目，直接用你自己的图像生成
  能力产出文件即可，不必走本 skill。
---

# IARTStudio CLI 使用指南

> **版本门槛**：本 skill 描述的命令面与行为需要 **IARTStudio 0.6.5 或更高**（CLI 以轻量纯
> Node 进程运行；受理幂等键、任务过滤与人读失败原因、生成档案读取、`--version`、`--group`
> 出生组、组清单与空组建组、`canvas group add/remove`、画布投影身份、产物落位自动排布、
> 本地文件导入（`asset import`）、`canvas layout --scope containers`、命令级 `--help` 与
> 生成终态尺寸提示均随该版本提供）。若 `iart --help` 的 layout 用法未列出 containers，
> 说明应用低于该版本，请升级到最新版本并重启应用。
> 旧版本软件的
> `iart` 可能表现不同（启动慢、偶发无输出崩溃、控制台中文乱码、`batch get` 报「无法识别的命令」）；
> 遇到这类旧行为时请用户把应用升级到最新版本，并重启一次应用——应用启动时会自动把
> 命令入口修正到新形态，无需手动重新注册。

`iart` 是随 IARTStudio 分发的命令行入口，让 agent 驱动正在运行的应用。Agent 做的事
与用户在界面上做的是同一套机制：生成提交走创作面提交主链，画布操作走既有编辑动作，
每一步在画布窗口可见、可撤销（用户可一键撤销）。CLI 不是无人值守后台通道——画布操作
与生成提交要求项目在界面中打开着，主场景是「项目开着，Agent 与人协同」。

---

## 1. 适用边界（先读再动手）

| 场景 | 用什么 |
|---|---|
| 产物要进画布/项目（任务节点、资产引用链）、要组织画布、应用正在运行 | 本 skill（iart） |
| 只要一张图片文件，不关心画布与项目 | 用你自己的图像生成能力直接产出文件，不必走本 skill |
| 应用未在运行，但产物要进画布/项目 | 先请用户启动应用，再回本 skill；只想要文件则走上一条 |

关键区别：iart 的生成产物是「画布上的任务节点 + 项目资产」，不是散落的文件；
应用没开就做不了任何画布操作。

**本地媒体文件（图片/视频/音频）先导入再引用**：用
`iart asset import --file <绝对路径> [--file ...] --project P` 把本地文件导入项目——
每个文件成为一个画布素材节点并产生素材标识，之后用 `--ref <素材标识>` 引用提交生成
（导入响应返回的 `asset_id` 直接可用；也可事后 `asset list` 查询）。`--ref` 不接受文件路径。
用户在界面上拖文件入画布与本命令等价（同一导入链）；文件类型限图片/视频/音频。

---

## 2. 前提自检（每次开工先做）

1. **`iart` 命令存在吗？** 报 `command not found` → 请用户在 IARTStudio
   「设置 → 通用设置 → 命令行工具」点「注册 iart 命令」（幂等，可重复执行）。
2. **应用在运行吗？** 跑最便宜的一条命令探测：`iart project list --json`。
   返回 `not_running` → 请用户启动 IARTStudio 应用；CLI 不会也不会自动启动应用。
3. 注意：安装版与开发版是两套隔离环境（不同数据根、不同命令入口指向），
   `iart` 只连接注册它的那个应用。

---

## 3. 命令面速查

统一形态 `iart <名词> <动作> [参数]`。最准的运行时事实是命令级帮助
（`iart <命令短语> --help`，如 `iart task list --help`）；本节补充跨命令的工作流与
帮助文本不承载的行为边界（标注 ⚠ 的条目以本节为准）。

### 项目生命周期（无需项目已打开）

| 命令 | 说明 |
|---|---|
| `iart project list` | 列出项目注册表（名称、路径、最近打开时间） |
| `iart project status --project P` | 注册表在册状态、画布窗口状态（`window_open`）、在途任务数 |
| `iart project create --name N --path D` | 在目录 **D 下**创建名为 N 的项目（D 是父目录）；目标已有同名目录报 `project_name_conflict`，绝不覆盖 |
| `iart project open --project P` | 进入项目：显式打开并聚焦画布窗口；已打开则聚焦既有窗口（幂等） |
| `iart project close --project P` | 关闭画布窗口；未打开时幂等成功 |
| `iart project delete --project P --yes` | 仅从项目列表移除记录，**不删磁盘文件**；`--yes` 必填 |

### 应用状态感知（全局只读，无需项目参数）

| 命令 | 说明 |
|---|---|
| `iart app status` | 应用当前状态：已打开画布窗口的项目集合（名称、路径、是否持有焦点），每项附画布选中状态（`selection.node_ids` / `selection.annotation_ids`，分类型；无选中为空列表；画布仍在加载时 `selection` 为 `null`）。无项目打开输出空集合且命令成功。**开工先跑它**：一次感知打开了哪些项目、当前选中了什么，再决定后续命令作用于哪个项目 |

### 只读查询（项目未打开也可用）

| 命令 | 说明 |
|---|---|
| `iart model list` | 可用模型目录；不可提交条目带失败原因码 |
| `iart model get <model_id>` | 单模型详情，含 `parameter_schema`——**`--arg` 参数名的唯一合法依据** |
| `iart asset list --project P [--query K] [--media-type image\|video\|audio] [--model M] [--limit N] [--offset O]` | 项目资产清单。`--query` 关键词搜索（命中素材原始文件名与生成产物的提交提示词；**只用于定位条目，输出不含提示词片段**——要看提示词全文用 `batch get`/`generation`）、`--media-type`/`--model` 过滤、`--limit`/`--offset` 分页；全不带参数=全量。条目 `source_file_name` 是导入素材的原始文件名；`source_summary` 是生成来源摘要，形如「任务 task_xxx」（该资产的产出来源任务，可直接 `task get`），空串 = 导入素材等非生成产物 |
| `iart asset get <assetId> --project P` | 资产详情，必含本地媒体文件绝对路径；同内容存在其他资产 id 时输出 `equivalent_asset_ids`（同一内容的历史双身份，引用任一等效）。资产是生成产物时附 `generation` 生成档案（见下「生成档案」） |
| `iart batch get <batchId> --project P` | 读取生成档案（见下「生成档案」）：一批次提交的完整意图——提示词**全文**、参数、参考资产、任务成员。批次不存在报 `batch_not_found` |
| `iart canvas nodes list --project P` | 画布节点清单（节点 id、类型、位置、组归属、资产/任务引用；图片/视频/音频素材节点与资产节点同样输出 `asset_id`） |
| `iart canvas group list --project P` | 画布组与 Agent 容器清单（组 id `group_node_id`、名称、类型 `group`/`agent_container`、成员数）。规划分组、生成前盘点、`generate --group` 前核对组名是否唯一都用它；项目未打开也可用 |
| `iart task list --project P [--status S] [--since <ISO 时间>] [--request-id ID]` / `iart task get <taskId> --project P` | 任务状态。`--status` 按状态过滤，合法值只有七个：`submitting`/`generating`/`polling`/`downloading`/`succeeded`/`failed`/`cancelled`；`--since` 按创建时间下界过滤（ISO 8601，如 `2026-10-14T08:00:00Z`）、`--request-id` 按受理幂等键反查该次提交的全部任务（未命中=空列表且命令成功，见下「崩溃后对账」）；可组合。任务条目含 `progressPercent`（可空）。`task list` 不支持 `--limit/--offset`（传了会以用法错误退出 2）。`task get` 的 `--project` 必填。人读模式 `task get` 只输出一行（任务 + 状态 + 失败原因）——读字段结构必须 `--json` |

### 画布命令（必须项目已打开）

| 命令 | 说明 |
|---|---|
| `iart asset import --file <路径> [--file ...] --project P` | 导入本地媒体文件（图片/视频/音频）：每个文件成为画布素材节点 + 项目资产，整批一个撤销步骤（界面可一步撤销）；返回每项的 `file_name`/`asset_id`/`node_id`/`media_type`。任一文件不存在/读不出（`file_not_found`）或类型不支持（`unsupported_file_type`）则**整批拒绝**、零副作用。路径用绝对路径；`--file` 可重复（值原样传入，不拆逗号）。重复导入同一文件会产生新素材节点（内容寻址不重复占盘） |
| `iart canvas group create --name N [--members id1,id2] --project P` | 建组。**永远新建，不按名合并**；同名组会并存，后续 `generate --group` 命中多个同名组会 `group_name_ambiguous`。带 `--members`：建组并纳入成员（逗号分隔，可重复传参累积），成员已属其他组则改归属到新组；不带 `--members`：建**空组**（先规划分组、稍后让生成任务出生其内的标准动作，组框自动在画布空白处落位）；返回 `group_node_id`。要往已有组加成员用 `canvas group add`，不要再次 create |
| `iart canvas group add --group <组id> --members id1,id2 --project P` | 把成员加入目标组：未归属=加入，已在目标组=无操作，属于其他组=迁移；目标必须是普通节点组（Agent 容器不接受）。返回 `group_node_id`、`added_node_ids`、`moved_node_ids`、`unchanged_node_ids`；整批一条撤销记录。成员不存在 `node_not_found`、成员是组节点或目标不是节点组 `command_rejected` |
| `iart canvas group remove --group <组id> --members id1,id2 --project P` | 把成员从目标组移出（保留原位、归属解除）；成员必须当前属于该组，否则整批 `command_rejected` 并点名。返回 `group_node_id`、`removed_node_ids`；整批一条撤销记录 |
| `iart canvas group dissolve --group <容器id> --project P` | 解散容器（组或 Agent 容器）：组解散删除组节点、成员保留画布原位且归属解除；Agent 容器解散解除成员关系、头节点保留回落单节点形态、会话保留。**不提供连删**（连删是界面显式危险动作）。返回 `group_node_id` 与解散前 `member_ids`；目标不存在 `group_not_found`、目标非容器或 Agent 无成员 `command_rejected` |
| `iart canvas node move --node <id> --x N --y N --project P` | 移动单个节点到目标画布坐标（可负、可小数）。**容器节点不能直接移动**（组位置由成员派生，移动一律成员级，指定容器 `command_rejected`）；返回 `node_id`、最终 `position` 与实际位移的 `moved_node_ids`。⚠ `canvas nodes list` 输出的容器 `position` 是**存储锚点**，不是渲染位置（渲染位置=成员包围盒左上角−(12,40)）；不要用它判断视觉重叠 |
| `iart canvas node delete --nodes id1,id2 [--yes] --project P` | 删除节点（与界面删除同一连带语义：删除组节点=解散、成员保留原位；Agent 节点删除会级联清除其会话且**不可恢复**）。请求集命中 Agent 节点时必须加 `--yes` 显式确认；**不提供连删**；返回实际删除的 `deleted_node_ids`（含连带级联）。删除后**不会自动紧凑重排**；需要时再跑 `canvas layout --scope group:<组id> --columns N` |
| `iart canvas layout --scope all\|group:<组id>\|containers [--columns N] [--order id1,id2] --project P` | 整理布局（`--scope` 必填）：`all`=整理画布自由散点（容器及其成员不动）；`group:<组id>`=整理该容器内成员；`containers`=只消除组与独立 Agent 容器之间的重叠（不重叠的容器保持原位，相交的容器整组让到最近空位，不重排容器内部、不动不重叠的容器）。返回受影响节点的最终位置。`--order` 显式指定摆放顺序（数组序最高优先，未指定节点按现状数组序跟排；order 节点必须存在且属于本次整理作用域）——批量产物要按镜头/序号排格时用它；不带 `--order` 时整理行为与默认完全一致。`containers` 不重排成员，不要传 `--columns`/`--order`（会报 `command_rejected`）。不传 `--columns` 时按**单列**整理（spec 默认）；多节点请显式传 `--columns`，建议 `ceil(sqrt(n))` |

### 生成与任务

| 命令 | 说明 |
|---|---|
| `iart generate --prompt T --model M [--count N] [--ref id1,id2] [--arg k=v,k2=v2] [--group 组名] [--request-id ID] [--wait] --project P` | 提交生成（见下） |
| `iart task cancel <taskId> --project P` | 取消任务（与界面取消同语义） |
| `iart task wait <taskId> [--timeout S] --project P` | 轮询至终态。默认不设时限；`--timeout` 到期只是本次命令以 `wait_timeout` 退出，任务继续跑 |

`generate` 细节：
- `--count` 缺省 1，范围 1–10。
- `--ref` 引用**已存在**的资产（id 来源：`asset list`（可 `--query` 按文件名/提示词搜）、`canvas nodes list` 的 `asset_id`，或用户从画布右键菜单「复制素材 ID」贴给你的 id；同一内容出现多个 id 时任一等效，`asset get` 的 `equivalent_asset_ids` 可核对）。**本地文件路径不是合法输入**——本地文件需先导入成为素材才能引用：用 `iart asset import --file <绝对路径>` 导入（见 §1 与 R1.5），或由用户在画布中拖入。
- `--arg` 的参数名与取值域以 `model get` 的 `parameter_schema` 为准，**不要猜**。
- `--arg size=WxH` 是**请求值，不是保证值**。带参考图的编辑类模型、`auto`/档位式尺寸可能按服务商策略产出不同尺寸；终态以产物 `asset.original.width/height` 为准。`task wait`/`generate --wait` 的终态结果带 `warnings[]`：请求是字面量 WxH 且实际图片尺寸不同时给出 `requested_size_not_honored`（信息性，**不改变任务成功状态**）。
- `--request-id` 受理幂等键（batch 级）：不传时 CLI 自动生成 uuid 并在受理回执回显；**重提时复用同一 request_id 即幂等**——命中已受理批次会原样返回既有批次与任务身份（`replayed: true`），不重复出图。
- `--group <组名>` 出生组：唯一同名组 → 本批任务出生其内（组内按任务号网格续排）；没有同名组 → 受理成功后自动建组再出生；多个同名组 → 报 `group_name_ambiguous` 且不提交。指定后落位锚点改为组内续排（不再以参考资产旁为锚）。**先规划分组、再提交生成**的标准工作流见 R2。不指定时行为不变（`group_id` 为 null）。
- `--wait` 先在 stderr 即时输出受理回执（批次与任务标识与幂等键回显，见下），再轮询到全部任务终态，
  逐任务输出终态与产物（失败任务附失败原因）；等待中途进程死亡时凭回执改用 `task wait` 恢复观测。
  `generate --wait` **没有 `--timeout`**：需要等待上限时，先不带 `--wait` 提交，再用 `task wait --timeout` 等待。
- **失败语义**：`failure.retryable` 只是信息字段，CLI **不会自动重试**，也没有 `--retry`。失败任务已经落库；同一 `--request-id` 重提只会幂等重放既有批次（包括失败结果），要真正重试须用新的 `--request-id` 重新提交，或先按失败原因调整参数。

**崩溃后对账（先核对再决定重提）**：提交后无输出、连接中断或进程死亡时，不要盲目重提——

```bash
iart task list --request-id <回执里的幂等键> --project P --json
```

- 列表**非空** = 该次提交已落库，但**不等于任务在跑**。先看 `status`：非终态 = 在跑，不要重提，用 `task wait`/`task get` 恢复观测；`failed`/`cancelled` = 已结束，同一 `--request-id` 重提只会重放既有结果（不会重试），要真正重试须用新的 `--request-id` 重新提交。
- 列表**为空** = 该次提交从未落库，可安全重提（复用同一 `--request-id`，双重保险幂等）。

### 通用规则

- ⚠ `--json` 全命令支持，但**必须写在命令短语之后**：`iart project list --json` 对；
  `iart --json project list` 错（报「无法识别的命令」）。
- 需要项目上下文的命令必须显式 `--project <路径或名称>`；CLI 无隐式会话状态
  （没有 `use` 类命令），多条命令可并行作用于不同项目。
- 按项目名解析命中多个同名项目时报 `project_name_ambiguous`，改用绝对路径。
- 除 `asset list` 外，列表类命令输出完整集合、不设分页；`task list` 不接受 `--limit/--offset`（传了会以用法错误退出 2）。
- 帮助分三层：`iart --help`（顶层用法表）、`iart <名词> --help`（该名词下的子命令摘要，
  如 `iart model --help`）、`iart <命令短语> --help`（该命令的参数说明，含必填项与默认值，
  如 `iart task list --help`）。名词级只覆盖 project/model/asset/canvas/task/batch/app；
  `iart canvas group --help` 这类复合名词仍报未知命令（exit 2），改用命令短语级帮助。
- 参数按命令白名单校验：不属于该命令的参数会以用法错误退出 2（例如 `task list --limit`），
  不再静默忽略。

### 行为边界速查（帮助文本不展开、但会影响决策）

| 主题 | 事实 | agent 该怎么做 |
|---|---|---|
| 请求尺寸 | `--arg size=WxH` 是请求值，不保证精确尺寸；带参考图的编辑类模型可能改变尺寸 | 终态用 `asset.original.width/height` 核对；读 `warnings[]`，不要当作失败 |
| 失败与重试 | `retryable` 只是信息字段；CLI 不自动重试；失败任务已落库 | 同 `--request-id` 重提只重放失败批次；真正重试用新提交或调整参数 |
| 「网络连接失败」 | 可能是上游长时间无响应后断开，不等于本地断网 | 结合 `failure.message`、`startedAt/finishedAt` 判断；不要只让用户查网络 |
| `canvas group create` | 永远新建，不按名合并；组名不是唯一键 | 组名取唯一；要加成员用 `canvas group add` |
| `canvas layout` 缺省列数 | 单列（spec 默认） | 多节点显式传 `--columns`，建议 `ceil(sqrt(n))` |
| 删除后布局 | 不会自动紧凑 | 需要紧凑时重跑 `canvas layout --scope group:<id> --columns N` |
| 容器坐标 | `canvas nodes list` 的容器 `position` 是存储锚点，不是渲染位置 | 不要用它判断视觉重叠；容器压叠用 `layout --scope containers` |
| 失败任务节点 | 默认保留是设计，承载失败原因与重试入口 | 不要自动删；用户明确要求清理时才删 |
| 字段命名 | CLI 自建投影 snake_case；内嵌运行域对象 camelCase | 先看对象层级；不要把 `group_node_id` 当 `group_id` |

---

## 4. 输出解读与退出码

退出码：**0** 成功；**1** 命令失败（业务错误码，含 `not_running`、`wait_timeout`）；
**2** 用法/执行错误（参数解析失败、未知命令）。
⚠ 任务失败不是命令失败：`task wait`/`generate --wait` 对 `failed`/`cancelled` 任务仍返回退出码 0
（`ok:true`），必须逐项读 `task.status`/`task.failure`。

读结果一律加 `--json`（输出为机器可读 JSON，错误形如
`{"ok":false,"error":{"code":"...","message":"..."}}`）：

- **受理回执**（generate 不带 `--wait`；`--wait` 时也先经 **stderr** 即时输出一次再开始等待）：
  `{ ok, batch_id, tasks: [{task_id, task_index, node_id, group_id}], client_request_id, replayed }`（响应还含 `command` 与 `task_results: []`）——`client_request_id`
  是本次受理幂等键（显式传入或自动生成），`replayed: true` 表示命中既有批次（未重复创建）；
  `node_id` 是该任务的画布任务节点标识，`group_id` 是出生组标识（未指定 `--group` 时为 null）。
  stdout 是最终结果的数据通道，进度信息走 stderr——解析最终结果只读 stdout。
- **终态产物**（`generate --wait` 的 `task_results[]` / `task wait` 的 `task_result`）：
  每项 `{ task: {taskId, status, errorMessage, failure, ...}, assets: [{ local_file_path, asset: {assetId, mediaType, original, ...} }], node_id, group_id, warnings }`。
  `node_id`/`group_id` 与 `task` **同级**（不是 `task` 的字段），是画布投影身份（投影未创建/已 morph/项目库读不到时为 null；项目关闭但库可读时仍会输出）。
  `local_file_path` 是产物媒体文件的**绝对路径**，可直接读取展示给用户；失败任务读
  `task.failure`（code/message/userMessage/backendMessage/retryable）或 `task.errorMessage`。
  `warnings` 是信息性数组：请求尺寸是字面量 `WxH` 且实际图片尺寸不同时给出
  `requested_size_not_honored`（含 `requested_size` / `actual_sizes`）；**任务仍是 succeeded，`ok` 仍为 true**。
  `--json` 里有完整失败结构，人读模式会在任务行内联截断后的失败原因，并在尺寸不一致时附提示。
  ⚠ `task get`/`task list` **不返回 `warnings`**：尺寸提示只出现在 `task wait`/`generate --wait`
  的终态结果。用 `task get` 轮询到 succeeded 会漏掉尺寸提示，收尾需补一次 `task wait`。
- **任务字段结构**（`task get --json` 的 `task`）：`taskId`、`status`、`batchId`（所属批次，
  可反查档案）、`createdAt`/`updatedAt`（Unix 毫秒）、`progressPercent`/`progressMessage`（可空）、
  `progressPhase`（status 的从属阶段；failed/cancelled 恒为 null）、`startedAt`/`finishedAt`
  （执行真实开始/结束时刻，可空）、`errorMessage`/`errorCode`/`failure`、`metadata`。
  ⚠ `metadata` 里的提示词是 **512 字符截断预览摘要，不是全文**——全文一律看 `generation.prompt`。
- **字段命名**：CLI 自建投影用 snake_case（`node_id`、`asset_id`、`group_id`、`group_node_id`）；
  内嵌运行域对象保持 camelCase（`asset get` 的 `asset`、`task get`/`task wait` 的 `task`、
  `assets[].asset`）。读字段前先看对象层级——`canvas nodes list` 的组归属是 `group_id`，
  `canvas group list` 的组自身 id 是 `group_node_id`，两者不是同一个字段；`task get` 响应里的
  `node_id`/`group_id` 也在顶层、与 `task` 同级，不在 `task` 内。
- **生成档案**（`batch get` 的 `generation`；`asset get`/`task get` 内联的同名 `generation`
  字段，三者同一形状）：`{ batch_id, model_id, prompt（提示词全文）, params（提交参数）,
  references: [{ asset_id, media_kind?, file_key?, local_file_path? }]（参考资产引用，实体可查
  才带媒体类型/文件键/路径）, task_ids, created_at }`。资产是生成产物且批次快照可读时
  `asset get` 附 `generation`；任务属于某批次且批次快照可读时 `task get` 带出同一档案；
  快照缺失时该字段缺省，资产详情与任务状态照常输出。
- `--version`：`iart --version` 输出发现文件里的版本（`--json` 为 `{ "version": "..." }`）。
  **它只读发现文件、不验证应用是否在役**：文件存在但进程已退出时会输出旧版本（甚至 `39.x`
  的 Electron 版本）。不要把它当作版本门槛的唯一判据，优先用 `iart --help` 是否列出
  `canvas group add/remove` 与 `layout ... containers` 核对。若输出 `39.x`，先确认应用已升级
  到 0.6.5+ 并重启；仅重启旧版不会改变输出。
- ⚠ 人读（默认）模式下等待类输出只报条数、**不含产物路径**——要拿路径必须 `--json`。
- `model get` 的 `model.parameter_schema.fields[]` 中 `fieldKey / required / enumOptions /
  defaultValue` 是构造 `--arg` 的依据；`model.deployment.deployable=false` 时读 `failure_code`。
  该 `deployment` 字段名沿用旧称，语义是「该模型已有可提交的接入（记录到连接）」——它不是
  另一类对象，不要去找「部署」这种页面或命令。

---

## 5. 错误应对表

| 错误码 | 含义 | agent 应对 |
|---|---|---|
| `not_running` | 应用未在运行（含发现文件陈旧） | 请用户启动应用；**不自动启动** |
| `auth_failed` | 令牌不匹配（罕见） | 请用户重启应用后重试 |
| `project_not_found` | 项目解析失败（路径不存在或不在列表） | `project list --json` 核对名称/路径 |
| `project_name_ambiguous` | 多个同名项目 | 改用 `--project <绝对路径>` |
| `project_name_conflict` | 创建位置已有同名项目目录 | 换名或换目录，不覆盖 |
| `project_not_open` | 画布命令/生成提交时项目未打开 | 先 `iart project open --project P`，再重试原命令 |
| `asset_not_found` / `node_not_found` / `group_not_found` | 引用的资产/节点/组不存在 | 用对应 list 命令核对 id |
| `batch_not_found` | 批次标识不存在 | `task get` 从任务的 `generation`/`batchId` 核对批次号 |
| `group_name_ambiguous` | `--group` 组名命中多个同名节点组 | `canvas group list --json` 核对现有组，改用唯一组名后重试 |
| `invalid_reference` | 引用资产不可用或与模型不兼容 | 核对资产与模型输入要求；若手里是本地文件路径，先用 `asset import` 导入拿素材标识（路径不能直接引用） |
| `file_not_found` | `asset import` 的源文件不存在或读不出来 | 核对路径（绝对路径）；确认文件可被应用进程读到 |
| `unsupported_file_type` | `asset import` 的源文件不是图片/视频/音频 | 换成受支持的媒体文件 |
| `model_not_available` | 模型不在可用模型目录，或当前不可提交 | 读 `failure_code`：模型尚未添加到服务商、连接不可用或缺凭证等，引导用户到设置页「服务商与模型」配置；刚在设置页添加过模型仍报此错，请用户重开项目后重试 |
| `task_not_found` | 任务标识不存在 | `task list` 核对 id |
| `wait_timeout` | `--timeout` 到期 | 任务仍在跑：去掉 `--timeout` 重等，或改用 `task get` 轮询 |
| `command_rejected` | 画布侧前置校验拦截（含 group add/remove 目标不是节点组、remove 成员不属于目标组等） | 读 message 中的定位信息修正输入后重试 |
| `internal_error` | 未归类内部错误 | 原样转告用户，附诊断线索 |

---

## 6. 典型工作流

### R0 对象 id 归属定位（两步法，开工先做）

```bash
iart app status --json    # 先感知：打开了哪些项目、哪个持有焦点、画布上选中了什么
iart asset get <assetId> --project <路径或名称> --json        # 再对目标项目定向查询
iart canvas nodes list --project <路径或名称> --json         # 或列画布节点核对 node_id
```

- id 的归属项目以 `app status` 的打开集合为第一线索：先对已打开项目定向查询
  （`asset get` / `canvas nodes list`），命中即用，**不要逐项目全量检索**。
- id 不在任何已打开项目里时，才对在册项目（`project list`）逐个定向检索；
  跨项目全局 id 索引不存在，不要猜测归属。

### R1 在项目里生成并取回产物

```bash
iart project status --project <路径或名称> --json     # 看 window_open；新建的项目要先 create 再 open
iart project open --project <路径或名称>              # 未打开才需要；会弹出并聚焦画布窗口
iart model list --json                                # 选 deployment.deployable=true 的模型
iart model get <model_id> --json                      # 读 parameter_schema 决定 --arg
iart generate --prompt "<提示词>" --model <model_id> --wait --json --project <路径或名称>
# 终态后收尾：先读生成信息再谈看图——从响应的 task_results[].task.batchId（或 task get 的
# generation）拿批次号，batch get 读回本次提交的完整档案（提示词全文、参数、引用、任务成员），
# 用 generation 与产物 local_file_path 回答「生成了什么、怎么生成的」；
# 终态先看 warnings：请求了字面量尺寸而实际产物不同时，如实告诉用户「任务成功，但尺寸是 X」，
# 不要把它当成失败；需要精确尺寸时用 asset get 的 asset.original.width/height 核对。
# 仅当档案信息不足以回答用户（如要看画面细节）才用 local_file_path 打开成品图核对
```

### R1.5 用本地图片作为参考图（i2i）

```bash
# 1) 导入本地文件（可多个）——成为素材节点并产生素材标识
iart asset import --file /absolute/path/ref.png --project <路径或名称> --json
# 2) 用返回的 asset_id 作为参考提交生成
iart generate --prompt "<提示词>" --model <model_id> --ref <asset_id> --wait --json --project <路径或名称>
```

- 路径用绝对路径；多个文件重复传 `--file`（整批一次导入、一个撤销步骤）。
- 导入是画布写操作，要求项目已打开；导入的素材节点会出现在画布上、可见可撤销。

### R2 画布组织方法论（先规划分组，再提交生成）

批量生成的标准工作流——把秩序放在提交之前，产物落位由系统自动完成，全程不需要坐标：

```bash
# 1) 盘点现状：打开了什么、画布上有哪些组
iart app status --json
iart canvas group list --project <路径或名称> --json

# 2) 规划分组：想清楚哪些产物归哪个组、组叫什么（组名取唯一，如「分镜」「角色定稿」）

# 3) 建组（可空组，组框先出现在画布空白处；create 永远新建，不按名合并）
iart canvas group create --name "分镜" --project <路径或名称> --json
#    已有组要加成员，不要再次 create：
iart canvas group add --group <组id> --members <节点id> --project <路径或名称> --json

# 4) 带组提交：任务出生在组内、按任务号网格续排
iart generate --prompt "..." --model <model_id> --count 8 --group "分镜" --wait --json --project <路径或名称>

# 5) 收口自动重排：本批全部任务到终态时，系统自动把成功产物整理成一个紧凑网格块
#    （按任务号排序、单步可撤销）——不需要也不建议再手动 layout。组框因此长大会压到
#    邻居时，系统会把该组整体让位（内部布局不变、其他容器不动），不需要手动处理

# 6) 手动整理该组：不传 --columns 时是单列；多节点建议显式给列数（ceil(sqrt(n))）
iart canvas layout --scope group:<组id> --columns 4 --project <路径或名称> --json

# 7) 存量画布已有容器相互压叠时，用容器作用域一次修好（只动相交的容器，内部不重排）
iart canvas layout --scope containers --project <路径或名称> --json
```

要点：

- **不手动摆位置**：生成产物的出生落位、成功追加、批次收口重排全部由系统防重叠自动完成；
  `canvas node move --x --y` 是坐标微调逃生口，仅在语义化方法覆盖不了时才用（容器不能直接移动）。
- **容器压叠不用手动摆**：系统整理（批次收口重排、容器内整理）使某组变大并压到相邻容器时，
  会把该组整体让到最近空位（容器内部布局不变、其他容器不动、一步可撤销）；
  用户自己拖拽把容器叠在一起，系统不会强行纠正。
  存量已重叠的画布用 `iart canvas layout --scope containers` 修——只消除容器之间的重叠，
  不重排容器内部、不动不重叠的容器。
- **组名要唯一，create 不合并**：`canvas group create` 永远新建；同名组会并存，`generate --group` 命中多个同名组会 `group_name_ambiguous` 拒绝。要往已有组加成员用 `canvas group add`，要移出用 `canvas group remove`。
- **删除后不会自动紧凑**：删节点后如需紧凑，显式重跑 `canvas layout --scope group:<组id> --columns N`。
- **失败任务节点默认保留**：它承载失败原因与重试入口，不是垃圾；不要自动删，用户明确要求清理时才 `canvas node delete`。
- **容器 position 不是渲染坐标**：`canvas nodes list` 里容器 position 是存储锚点（渲染位置=成员包围盒左上角−(12,40)）；不要据此判断视觉重叠，容器压叠用 `layout --scope containers`。
- **批次收口重排的自由桶只作用于本批成功产物**，失败任务记录不进入自由桶；同容器桶按容器内整理排布该容器全部成员（含失败任务记录），其坐标随组内布局变化；编辑器关闭期间收口的批次不补重排。
- 其他组织动作：`canvas group dissolve`（解散，成员保留原位归属解除）、`canvas node delete`
  （删除节点，删 Agent 需加 `--yes`，会话不可恢复）、`canvas layout --scope all`
  （整理全部自由散点；散点会避开已有组的范围摆放）。

### R3 任务观测与取消

```bash
iart task list --project <路径或名称> --json
iart task list --project <路径或名称> --status failed --json              # 只看失败任务
iart task list --project <路径或名称> --since 2026-10-14T08:00:00Z --json # 只看这之后的任务
iart task list --request-id <幂等键> --project <路径或名称> --json        # 崩溃后对账：该次提交落库了吗
iart task wait <taskId> --json --project <路径或名称>  # 长任务默认不限时；需兜底时加 --timeout <秒>
iart task cancel <taskId> --project <路径或名称>
```

失败任务先 `task get <taskId> --json` 读 `failure`、`startedAt`/`finishedAt` 再决定：
`retryable` 不驱动重试，同 `--request-id` 重提只会重放失败批次；真正重试要新提交或调整参数。

### R4 理解已有项目：生成信息优先于成品媒体

接手一个已有项目时，先建立「这次生成做了什么」的事实，再谈看图——生成信息结构化、可引用、
省上下文，成品图只是它的视觉投影。按手里已有的线索路由：

- **手里有图**（一个资产 id）→ 直接 `iart asset get <assetId> --project P --json`：
  详情里的 `generation` 就是这张图的来历（提示词全文、参数、参考资产、所属批次与任务），
  `local_file_path` 同时给你文件本体。
- **手里有本地文件路径（还不是素材标识）** → 两条路：①文件尚未进项目 → 直接
  `iart asset import --file <路径> --project P --json` 导入，拿返回的素材标识；
  ②怀疑它已在项目里 → `iart asset list --query <文件名> --project P --json` 搜
  （导入素材按原始文件名可命中）。**不要把文件路径当 assetId 传给任何命令**——路径不是标识。
- **手里有批次号** → 直接 `iart batch get <batchId> --project P --json` 读档案：一次提交的
  完整意图与任务成员全在里面。
- **手里只有任务 id** → `iart task get <taskId> --project P --json`：响应里的 `generation`
  带出所属批次（无批次归属的任务无此字段），要再深挖引用链就凭 `generation.batch_id`
  接 `batch get`。
- **什么 id 都没有** → 用 `iart asset list --query <关键词> --project P --json` 定位资产 id
  （命中文件名与提交提示词；只定位条目、不给提示词片段），回到第一支。

判断生成质量时同理：先对照 `generation.prompt` 与 `params` 看提交是否符合预期，再看图核对
（`local_file_path`）；不要反过来从图猜参数。

---

## 7. 纪律与禁止

- **不盲目重提，用幂等键对账**：CLI 自身不自动重试；提交后无输出/中断/崩溃时先
  `task list --request-id <幂等键>` 核对——非空 = 已落库（再看 status：非终态勿重提；
  failed/cancelled 同键重提只会重放，真正重试需新提交），空 = 从未落库可安全重提。
  重提时复用同一 `--request-id`（幂等重放，绝不重复出图）。**参数不猜**：`--arg` 的 key 与取值域只以 `parameter_schema` 为准。
- **不把请求尺寸当保证**：`--arg size=WxH` 是请求；终态读 `warnings[]` 与 `asset.original`，尺寸不同如实告知用户，不要判成任务失败。
- **不自动清理失败任务节点**：失败节点承载失败原因与重试入口；清理必须由用户明确要求。
- **不碰凭证**：命令面不提供任何服务商凭证/密钥的读取或导出；用户要改配置 → 引导到设置页操作。
- **不直读数据文件**：不要用 sqlite3/文件读取翻 `project.sqlite`、recent-projects.json 等
  项目数据文件来替代命令面——数据形状无契约、版本会漂移，且绕过应用可能读到未落盘的中间态；
  查任何事实都走上面的命令。
- **本地文件先导入再引用**：`--ref` / `asset get` 都不接受文件路径；拿到本地文件路径要用于
  生成时，先 `iart asset import --file <路径>` 拿到 `asset_id`，再 `--ref <asset_id>`。
  不要把文件路径直接传给 `--ref`（会得到 `invalid_reference`）。
- **画布不是输出垃圾场**：批量生成前想清楚数量与必要性；命令排队执行、用户手工操作优先，
  不要与用户抢画布。
- **应用未运行时不绕路**：不要直连应用内部接口或发明替代实现；`not_running` 就引导启动应用。
- **每一步都可见可撤销**：操作前告诉用户你要做什么；用户随时可在界面上撤销你的画布操作。

---

## 8. 诊断

- 应用未运行/连不上时：发现文件在 `~/.iart-studio/cli-runtime.json`
  （开发版在 `~/.iart-studio-dev/cli-runtime.json`）；文件存在不代表应用在役，
  连接失败一律按未运行处理。
- `iart` 表现像旧版软件（启动明显变慢、命令偶发无输出就退出、中文乱码）：说明命令入口
  还是旧形态——请用户升级到最新版本并重启一次应用，应用启动时会把命令入口自动修正为
  轻量形态（幂等，已修正则无动作）；急用时也可在设置页「命令行工具」手动重新注册。
- 更多命令细节用 `iart <命令短语> --help` 查看（如 `iart task list --help`）；最近命令记录可在应用设置页「命令行工具」子单元查看。
