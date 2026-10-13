---
name: iart-cli
description: |
  通过 iart 命令行驱动正在运行的 IARTStudio 桌面应用（资产上下文画布创作空间）：
  打开/创建项目、提交生成并把产物落进画布、建组与整理布局、查询与等待生成任务。
  当用户提到「IARTStudio」「iArtStudio」「iart 命令」「在软件里生成」「把图放进画布」
  「打开项目」「建个组」「整理布局」「查一下生成任务」等意图时触发。
  前提：IARTStudio 应用正在运行（CLI 不会自动启动应用）；Agent 的每一步操作都在应用
  画布上可见、可撤销。若用户只想要图片文件、不涉及画布或项目（或应用未在运行），
  改用 gpt-image skill。
---

# IARTStudio CLI 使用指南

`iart` 是随 IARTStudio 分发的命令行入口，让 agent 驱动正在运行的应用。Agent 做的事
与用户在界面上做的是同一套机制：生成提交走创作面提交主链，画布操作走既有编辑动作，
每一步在画布窗口可见、可撤销（用户可一键撤销）。CLI 不是无人值守后台通道——画布操作
与生成提交要求项目在界面中打开着，主场景是「项目开着，Agent 与人协同」。

---

## 1. 适用边界（先读再动手）

| 场景 | 用什么 |
|---|---|
| 产物要进画布/项目（任务节点、资产引用链）、要组织画布、应用正在运行 | 本 skill（iart） |
| 只要一张图片文件，不关心画布与项目；或应用未在运行 | gpt-image skill（离线直调 Provider，产物是文件） |

关键区别：iart 的生成产物是「画布上的任务节点 + 项目资产」，不是散落的文件；
应用没开就做不了任何画布操作。

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

统一形态 `iart <名词> <动作> [参数]`。最准的运行时事实永远是 `iart --help`；
本节与其对齐并补充了帮助文本没写准的细节（标注 ⚠ 的三处以本节为准）。

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
| `iart model list` | 可执行模型目录；不可执行条目带失败原因码 |
| `iart model get <model_id>` | 单模型详情，含 `parameter_schema`——**`--arg` 参数名的唯一合法依据** |
| `iart asset list --project P [--query K] [--media-type image\|video\|audio] [--model M] [--limit N] [--offset O]` | 项目资产清单。`--query` 关键词搜索（命中素材原始文件名与生成产物的提交提示词）、`--media-type`/`--model` 过滤、`--limit`/`--offset` 分页；全不带参数=全量。条目 `source_file_name` 是导入素材的原始文件名 |
| `iart asset get <assetId> --project P` | 资产详情，必含本地媒体文件绝对路径；同内容存在其他资产 id 时输出 `equivalent_asset_ids`（同一内容的历史双身份，引用任一等效） |
| `iart canvas nodes list --project P` | 画布节点清单（节点 id、类型、位置、组归属、资产/任务引用；图片/视频/音频素材节点与资产节点同样输出 `asset_id`） |
| `iart task list --project P` / `iart task get <taskId> --project P` | 任务状态。⚠ `task get` 的 `--project` 必填（帮助文本省略了它） |

### 画布命令（必须项目已打开）

| 命令 | 说明 |
|---|---|
| `iart canvas group create --name N --members id1,id2 --project P` | 建组并纳入成员（至少 1 个，逗号分隔，可重复传参累积）；成员已属其他组则改归属到新组；返回 `group_node_id` |
| `iart canvas layout --scope all\|group:<组id> [--columns N] --project P` | 整理布局。⚠ `--scope` 必填（帮助文本写「可选」是过时的）；返回受影响节点的最终位置 |

### 生成与任务

| 命令 | 说明 |
|---|---|
| `iart generate --prompt T --model M [--count N] [--ref id1,id2] [--arg k=v,k2=v2] [--wait] --project P` | 提交生成（见下） |
| `iart task cancel <taskId> --project P` | 取消任务（与界面取消同语义） |
| `iart task wait <taskId> [--timeout S] --project P` | 轮询至终态。默认不设时限；`--timeout` 到期只是本次命令以 `wait_timeout` 退出，任务继续跑 |

`generate` 细节：
- `--count` 缺省 1，范围 1–10。
- `--ref` 引用**已存在**的资产（id 来源：`asset list`（可 `--query` 按文件名/提示词搜）、`canvas nodes list` 的 `asset_id`，或用户从画布右键菜单「复制素材 ID」贴给你的 id；同一内容出现多个 id 时任一等效，`asset get` 的 `equivalent_asset_ids` 可核对）。
- `--arg` 的参数名与取值域以 `model get` 的 `parameter_schema` 为准，**不要猜**。
- `--wait` 轮询到全部任务终态，逐任务输出终态与产物。

### 通用规则

- ⚠ `--json` 全命令支持，但**必须写在命令短语之后**：`iart project list --json` 对；
  `iart --json project list` 错（报「无法识别的命令」）。
- 需要项目上下文的命令必须显式 `--project <路径或名称>`；CLI 无隐式会话状态
  （没有 `use` 类命令），多条命令可并行作用于不同项目。
- 按项目名解析命中多个同名项目时报 `project_name_ambiguous`，改用绝对路径。
- 列表类命令输出完整集合，无分页。
- 帮助只有两层：`iart --help`（顶层用法表）与完整命令短语级 `--help`
  （如 `iart generate --help`）；`iart project --help` 这类名词级帮助**不存在**（报错退出 2）。

---

## 4. 输出解读与退出码

退出码：**0** 成功；**1** 命令失败（业务错误码，含 `not_running`、`wait_timeout`）；
**2** 用法/执行错误（参数解析失败、未知命令）。

读结果一律加 `--json`（输出为机器可读 JSON，错误形如
`{"ok":false,"error":{"code":"...","message":"..."}}`）：

- **受理回执**（generate 不带 `--wait`）：`{ ok, batch_id, tasks: [{task_id, task_index}] }`。
- **终态产物**（`generate --wait` 的 `task_results[]` / `task wait` 的 `task_result`）：
  每项 `{ task: {taskId, status, errorMessage, ...}, assets: [{ local_file_path, asset: {assetId, mediaType, ...} }] }`。
  `local_file_path` 是产物媒体文件的**绝对路径**，可直接读取展示给用户。
- ⚠ 人读（默认）模式下等待类输出只报条数、**不含产物路径**——要拿路径必须 `--json`。
- `model get` 的 `model.parameter_schema.fields[]` 中 `fieldKey / required / enumOptions /
  defaultValue` 是构造 `--arg` 的依据；`model.deployment.deployable=false` 时读 `failure_code`。

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
| `invalid_reference` | 引用资产不可用或与模型不兼容 | 核对资产与模型输入要求 |
| `model_not_available` | 模型不在可执行目录或不可执行 | 读失败原因码：缺部署/凭证等问题引导用户到设置页「服务商」分区配置 |
| `task_not_found` | 任务标识不存在 | `task list` 核对 id |
| `wait_timeout` | `--timeout` 到期 | 任务仍在跑：去掉 `--timeout` 重等，或改用 `task get` 轮询 |
| `command_rejected` | 画布侧前置校验拦截 | 读 message 中的定位信息修正输入后重试 |
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
iart model list --json                                # 选 deployable=true 的生成模型
iart model get <model_id> --json                      # 读 parameter_schema 决定 --arg
iart generate --prompt "<提示词>" --model <model_id> --wait --json --project <路径或名称>
# 终态后从 task_results[].assets[].local_file_path 拿产物绝对路径，用 Read 展示给用户
```

### R2 组织画布

```bash
iart canvas nodes list --project <路径或名称> --json  # 拿 node_id 与现有 group_id
iart canvas group create --name <组名> --members <id1,id2> --project <路径或名称>
iart canvas layout --scope all --project <路径或名称>  # 或 --scope group:<新组id> 只整理该组
```

### R3 任务观测与取消

```bash
iart task list --project <路径或名称> --json
iart task wait <taskId> --json --project <路径或名称>  # 长任务默认不限时；需兜底时加 --timeout <秒>
iart task cancel <taskId> --project <路径或名称>
```

---

## 7. 纪律与禁止

- **生成提交不幂等，不自动重试**：传输层失败原样报错；是否重新提交由你判断并让用户知情。
- **参数不猜**：`--arg` 的 key 与取值域只以 `parameter_schema` 为准。
- **不碰凭证**：命令面不提供任何服务商凭证/密钥的读取或导出；用户要改配置 → 引导到设置页操作。
- **画布不是输出垃圾场**：批量生成前想清楚数量与必要性；命令排队执行、用户手工操作优先，
  不要与用户抢画布。
- **应用未运行时不绕路**：不要直连应用内部接口或发明替代实现；`not_running` 就引导启动应用。
- **每一步都可见可撤销**：操作前告诉用户你要做什么；用户随时可在界面上撤销你的画布操作。

---

## 8. 诊断

- 应用未运行/连不上时：发现文件在 `~/.iart-studio/cli-runtime.json`
  （开发版在 `~/.iart-studio-dev/cli-runtime.json`）；文件存在不代表应用在役，
  连接失败一律按未运行处理。
- 更多命令细节用 `iart --help` 查看；最近命令记录可在应用设置页「命令行工具」子单元查看。
