# IARTStudio（PC 桌面版）

IARTStudio 是一款**资产上下文画布创作空间**桌面应用：资产是第一公民，PromptDock 是唯一生成入口；画布承载资产/素材节点、任务节点、注释与空间组织，生成产物直接落进画布。

## 下载与安装

正式版安装包在 [Releases](https://github.com/tf961656585/IArt/releases/latest) 页面下载，覆盖三个平台：

| 平台 | 安装包 |
|---|---|
| Windows（x64） | NSIS 安装程序（`.exe`） |
| macOS（Apple Silicon / Intel） | `.dmg`（拖入「应用程序」）；另附 `.zip` 供应用内更新使用 |
| Linux（x64） | AppImage |

安装包均未做代码签名，首次打开可能需要手动放行：

- **macOS**：右键点击应用 →「打开」，或到「系统设置 → 隐私与安全性」选择「仍要打开」。若提示「已损坏 / 无法验证」，在终端执行 `sudo xattr -cr /Applications/IARTStudio.app`。
- **Windows**：SmartScreen 提示「未知发布者」时，点「更多信息 → 仍要运行」。

更新方式：Windows 与 macOS 可在应用内「设置 → 检查更新」发现新版本、自行决定是否下载，下载完成后按提示打开安装文件并手动替换；Linux 不提供应用内更新，请从 Releases 页面下载新的 AppImage。

## 仓库结构

运行形态为 **Electron 宿主 + Hub 前端 + Editor 前端 + Backend**：

- **Desktop Shell（`apps/desktop-shell`）**：负责 Electron 宿主能力、窗口生命周期与 preload bridge。
- **Hub（`apps/hub`）**：负责项目入口、系统管理与任务观察；dev 时经 backend `/hub` 代理到受控 Hub dev server，pack/runtime 时托管 `apps/hub/dist-static/**`。
- **Editor（`apps/editor`）**：负责创作交互与显示；pack/runtime 时加载 `apps/editor/dist-static/**`。
- **Backend（`apps/backend`）**：负责项目数据、任务执行、媒体本地化与正式业务状态。

## 开发

先决条件：Node.js ≥ 22、pnpm ≥ 10（`npm i -g pnpm@10` 或启用 corepack）。

安装依赖：

```bash
pnpm install
```

按需准备环境变量（可选，示例见 `.env.example`，全部键留空也能运行）：

```bash
cp .env.example .env
```

公共中转端点无需写进 `.env`，可在应用内「设置 → 公共中转」直接配置。

启动桌面联调（backend + hub dev + editor dev + Electron）：

```bash
pnpm desktop:dev:debug
```

启动桌面 latest 静态链路（启动前重建 Hub static + Editor static，再进入桌面运行时链路）：

```bash
pnpm desktop:dev:latest
```

构建 workspace 与静态产物：

```bash
pnpm build
```

只验证本地 backend：

```bash
env IART_BACKEND_PORT=39000 pnpm backend:dev
pnpm verify:local-backend -- --port 39000
```

如需做桌面静态 ownership smoke：

```bash
pnpm verify:desktop-smoke
```

## Native 模块隔离准备（Node / Electron）

`better-sqlite3` 是原生模块，仓库现在会为 Node 与 Electron 分别准备两份隔离产物，避免互相覆盖：

```bash
# 只准备 Node 运行时
pnpm abi:node -- --verify

# 只准备 Electron 运行时
pnpm abi:electron -- --verify

# 一次性准备两边
pnpm sqlite:prepare -- --verify
```

如提示忽略构建脚本，请先执行：

```bash
pnpm approve-builds
```

## 打包

先完成 workspace 构建，再做桌面收包校验：

```bash
pnpm build
pnpm desktop:pack
```

### Windows（x64）

```bash
pnpm desktop:dist:win:x64
```

产物输出到 `dist-desktop/`（NSIS 安装器与差量更新 blockmap）。

### macOS（本地打包，未签名）

需在 macOS 上执行。两个架构要**分别构建**：FFmpeg 与 better-sqlite3 这类原生依赖在单次构建里只能是一种架构，一次调用同时出双架构会得到架构错配的产物。

```bash
# Apple Silicon
pnpm desktop:dist:mac:arm64

# Intel（构建前会先切换原生依赖形态）
pnpm desktop:dist:mac:x64
```

每次构建产出该架构的 `dmg + zip`，输出到 `dist-desktop/`：

- `IARTStudio-<version>-mac-arm64.dmg` / `.zip`（Apple Silicon）
- `IARTStudio-<version>-mac-x64.dmg` / `.zip`（Intel）

`pnpm desktop:dist:mac` 只构建 Apple Silicon（等同于 `desktop:dist:mac:arm64`）；`pnpm desktop:dist:mac:zip` 只产出 Apple Silicon 的 zip。要发双架构，两条架构命令都要跑一次。

DMG 安装页已内置「拖动应用到 Applications」指引背景。

### Linux（x64）

需在 Linux 上执行：

```bash
pnpm desktop:dist:linux:x64
```

产物为 `dist-desktop/` 下的 AppImage。Linux 版不提供应用内更新。

## 测试与门禁

集成测试（`testing/integration/`）依赖桌面构建产物，先执行一次 `pnpm build`（即完整预飞主链）再跑全量测试：

```bash
# Backend 全量用例（node:test）
pnpm test:backend

# 其余包全量用例（vitest）
npx vitest run

# 类型、lint、边界与稳定业务类型守卫
pnpm check:types-and-boundaries
```

应用内更新基于 [electron-updater](https://www.electron.build/auto-update) 实现，更新源由打包配置（根 `package.json` 的 `build.publish`）决定，默认指向本仓库的 Releases。

- **Windows**：发现新版本后由你决定是否下载；下载完成后「打开安装器」，按向导升级。
- **macOS**：产物未签名，走不了系统自动安装。下载完成后按提示「打开文件所在位置」，用新包替换「应用程序」里的旧版再重启。
- **Linux**：不发起应用内更新检查，设置页给「前往下载页」入口，从 Releases 手动下载新的 AppImage。

## 许可证

本项目基于 [MIT](./LICENSE) 许可证开源。第三方组件的许可证信息见 [NOTICES.md](./NOTICES.md)。
