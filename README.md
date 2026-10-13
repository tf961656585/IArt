# IARTStudio（PC 桌面版）

IARTStudio 是一款**资产上下文画布创作空间**桌面应用：资产是第一公民，PromptDock 是唯一生成入口；画布承载资产/素材节点、任务节点、注释与空间组织，生成产物直接落进画布。官方分发面向 Windows PC 桌面；macOS 可按下方步骤本地打包（产物未签名）。

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

> 说明：此方式会产出未签名的 macOS 包（用于本地运行与测试）。在 macOS 上首次打开通常需要 **右键 → 打开**（或到“系统设置 → 隐私与安全性”里允许）。
> 说明：`desktop:dist:mac` 需要在 macOS 上运行，会自动生成 `apps/desktop-shell/resources/icons/icon.icns`。
> 说明：DMG 安装页面已内置“拖动应用到 Applications”指引背景。

构建 `dmg + zip`（x64 + arm64）：

```bash
pnpm desktop:dist:mac
```

产物输出到 `dist-desktop/`，包含：
- `IARTStudio-<version>-mac-x64.dmg`（Intel）
- `IARTStudio-<version>-mac-arm64.dmg`（Apple Silicon）
- `IARTStudio-<version>-mac-x64.zip`（Intel）
- `IARTStudio-<version>-mac-arm64.zip`（Apple Silicon）

若首次启动仍遇到系统拦截（如“已损坏/无法验证”），可在终端执行：

```bash
sudo xattr -cr /Applications/IARTStudio.app
```

建议直接把 `/Applications/IARTStudio.app` 从 Finder 拖入终端，自动填充完整路径后再回车执行。

如需兼容旧流程（仅构建 `zip`）：

```bash
pnpm desktop:dist:mac:zip
```

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

应用内更新基于 [electron-updater](https://www.electron.build/auto-update) 实现：Windows 走 NSIS 安装器；macOS 产物未签名，更新形态为「提示新版本 → 打开已下载安装器」。更新源由打包配置（根 `package.json` 的 `build.publish`）决定，可指向 GitHub Releases 或任意 generic 静态源。

## 许可证

本项目基于 [MIT](./LICENSE) 许可证开源。第三方组件的许可证信息见 [NOTICES.md](./NOTICES.md)。
