import type { CommandFlagSpec, CommandSpec } from "./cli-command-catalog.cjs";

/**
 * 画布子命令短语表（spec §5.2–§5.3）。
 *
 * 从 cli-arg-parser 抽出（行数预算拆分，符号级等价搬运，先例同 cli-canvas-read-executors）：
 * 顶层用法表、名词级帮助与命令级帮助仍由 parser 的 COMMAND_SPEC_LIST 统一渲染，
 * 本文件只是该表的画布子集，禁止在别处另写命令/参数清单。
 */

/** 画布命令共享的 --project 必填约束（parser 的其它命令复用同一定义）。 */
export const REQUIRED_PROJECT: CommandFlagSpec = { name: "--project", required: true };

export const CANVAS_COMMAND_SPECS: readonly CommandSpec[] = [
  {
    phrase: "canvas nodes list",
    command: "canvas.nodes.list",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "列出画布节点（标识、类型、显示名、位置、组归属与引用）。",
    syntax: "iart canvas nodes list --project P",
  },
  {
    phrase: "canvas group list",
    command: "canvas.group.list",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "列出画布组与 Agent 容器（标识、名称、类型、成员数）。",
    syntax: "iart canvas group list --project P",
  },
  {
    phrase: "canvas inspect",
    command: "canvas.inspect",
    positionals: [],
    flags: [
      REQUIRED_PROJECT,
      { name: "--full" },
      { name: "--group" },
      { name: "--prompt-limit" },
      { name: "--no-unplaced" },
    ],
    summary: "一次输出整张画布场景图（节点几何、容器派生框、未落画布资产、注释、重叠与间距）。",
    syntax:
      "iart canvas inspect --project P [--full] [--group <容器id>] [--prompt-limit N] [--no-unplaced]",
    notes: [
      "项目画布窗口打开时合并窗口内精确几何（fidelity=exact），否则输出离线派生几何。",
      "缺省输出紧凑摘要（提示词截断 200 字符）；--full 返回完整提示词与嵌套资产摘要。",
      "--group 只看该容器及后代成员/容器/绑定注释；未知组报 group_not_found。",
    ],
  },
  {
    phrase: "canvas group create",
    command: "canvas.group.create",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--name", required: true }, { name: "--members" }],
    summary: "创建组并加入成员；省略 --members 时创建空组。",
    syntax: "iart canvas group create --name N [--members id1,id2] --project P",
  },
  {
    phrase: "canvas group rename",
    command: "canvas.group.rename",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--group", required: true }, { name: "--name", required: true }],
    summary: "重命名节点组；Agent 容器标题由会话管理，不接受重命名。",
    syntax: "iart canvas group rename --group <组id> --name N --project P",
    notes: ["一次重命名 = 一条撤销记录；本命令不登记按操作撤销（canvas undo 返回 command_rejected）。"],
  },
  {
    phrase: "canvas group dissolve",
    command: "canvas.group.dissolve",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--group", required: true }],
    summary: "解散组或 Agent 容器；成员保留在画布上。",
    syntax: "iart canvas group dissolve --group <容器id> --project P",
  },
  {
    phrase: "canvas group add",
    command: "canvas.group.add",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--group", required: true },
      { name: "--members", required: true },
    ],
    summary: "把成员加入目标组；已在组内无操作，属于其他组时迁移过来。",
    syntax: "iart canvas group add --group <组id> --members id1,id2 --project P",
    notes: ["目标必须是节点组；Agent 容器的成员由会话管理，不接受加入/移出。"],
  },
  {
    phrase: "canvas group remove",
    command: "canvas.group.remove",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--group", required: true },
      { name: "--members", required: true },
    ],
    summary: "把成员移出目标组；成员保留在画布原位。",
    syntax: "iart canvas group remove --group <组id> --members id1,id2 --project P",
    notes: ["成员必须当前属于该组；任一成员不属于时整批拒绝。"],
  },
  {
    phrase: "canvas node move",
    command: "canvas.node.move",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--node", required: true },
      { name: "--x", required: true },
      { name: "--y", required: true },
      { name: "--dry-run" },
    ],
    summary: "把单个节点移动到目标画布坐标。",
    syntax: "iart canvas node move --node <节点id> --x N --y N --project P",
  },
  {
    phrase: "canvas nodes move",
    command: "canvas.nodes.move",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--nodes" },
      { name: "--dx" },
      { name: "--dy" },
      { name: "--positions" },
      { name: "--dry-run" },
    ],
    summary: "把一批节点整体做相对位移（--nodes/--dx/--dy），或逐个落到绝对坐标（--positions）。",
    syntax:
      "iart canvas nodes move (--nodes id1,id2 --dx N --dy N | --positions id=x,y [--positions id2=x2,y2 ...]) [--dry-run] --project P",
    notes: [
      "相对位移族（--nodes/--dx/--dy）与绝对坐标族（--positions）互斥；两族都没给按用法错误拒绝。",
      "相对族要求 --nodes/--dx/--dy 三者齐全；可含容器，成员随容器一起移动。",
      "--positions 可重复，每条一个节点；节点标识重复按用法错误拒绝。",
      "任一节点不存在时整批拒绝；一次批量写入只产生一条撤销记录。",
    ],
  },
  {
    phrase: "canvas group move",
    command: "canvas.group.move",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--group", required: true },
      { name: "--dx" },
      { name: "--dy" },
      { name: "--x" },
      { name: "--y" },
      { name: "--dry-run" },
    ],
    summary: "按容器寻址移动：相对位移（--dx/--dy）或绝对落点（--x/--y）二选一。",
    syntax: "iart canvas group move --group <容器id> (--dx N --dy N | --x N --y N) [--dry-run] --project P",
    notes: [
      "相对位移与绝对落点互斥；两族至少各给一个轴，未给的轴保持当前。",
      "容器位置由成员派生：移动换算为成员位移；空容器直接移动容器自身。",
    ],
  },
  {
    phrase: "canvas node delete",
    command: "canvas.node.delete",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--nodes", required: true }, { name: "--yes" }],
    summary: "删除一个或多个节点；直接命中 Agent 节点时需要 --yes 确认。",
    syntax: "iart canvas node delete --nodes id1,id2 [--yes] --project P",
  },
  {
    phrase: "canvas node create",
    command: "canvas.node.create",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--asset", required: true },
      { name: "--group" },
      { name: "--x" },
      { name: "--y" },
      { name: "--dry-run" },
    ],
    summary: "把已有资产放回画布（只创建资产节点，可指定组与否）。",
    syntax: "iart canvas node create --asset <资产id> [--group <组id>] [--x N --y N] [--dry-run] --project P",
    notes: [
      "只按资产节点（type=asset）物化；素材节点仍只能经 asset import 导入链创建。",
      "同一资产可重复放入画布（每次创建一个新资产节点），不阻断也不报错。",
      "--x 与 --y 必须同时给出；省略时复用导入链的防重叠落位。",
    ],
  },
  {
    phrase: "canvas layout",
    command: "canvas.layout",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--scope" },
      { name: "--plan" },
      { name: "--columns" },
      { name: "--order" },
      { name: "--order-mode" },
      { name: "--pack" },
      { name: "--gap" },
      { name: "--dry-run" },
    ],
    summary: "整理画布、组或容器布局（默认按视觉阅读序；--pack 把顶层容器排成行列看板），或用计划文件一次完成多组排布。",
    syntax:
      "iart canvas layout (--scope all|containers|group:<id> [--order-mode position|created|insertion] [--columns N] [--order id1,id2] [--gap N] [--pack [--gap N]] | --plan <路径>) [--dry-run] --project P",
    notes: [
      "两种模式二选一：--scope 族（逐次整理）或 --plan（计划文件），不能同时给出；两者都缺按用法错误拒绝。",
      "计划文件为 JSON：groups[]（逐个顶层组网格排布）、containers（整版容器排布）、positions（显式坐标）三段均可选；--order-mode 仅支持 position/insertion。",
      "一段计划 = 一次批量写入 = 一条撤销记录；--dry-run 两种模式都可用（只输出计划位置，零写入、零撤销记录）。",
      "默认排序为视觉阅读序（--order-mode position）；--order 显式顺序优先于排序模式。",
      "containers 作用域不带 --pack 时只消除容器之间的占位相交，不接受 --columns、--order、--order-mode 与 --gap。",
      "all/group 作用域缺省 columns=1、gap=120；gap 是格子内间距的精确值（整块锚点吸附到最近网格点）。",
      "--pack（仅 containers）把顶层容器按渲染框排成行列看板，可用 --columns 指定列数、--gap 指定间距（缺省 120）；此时允许 --order 指定容器顺序。",
    ],
  },
  {
    phrase: "canvas undo",
    command: "canvas.undo",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--operation", required: true }],
    summary: "按操作撤销一次位置写入（整理 / 移动）；不影响其间的用户手工编辑。",
    syntax: "iart canvas undo --operation <操作id> --project P",
    notes: ["只支持位置类操作；画布窗口重新加载后此前的操作记录会失效。"],
  },
];
