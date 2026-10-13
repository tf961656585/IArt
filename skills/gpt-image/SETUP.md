# gpt-image 安装与配置

本 skill 开箱即用：只要本机安装并运行过 IARTStudio（Provider 配置已保存），脚本即可
离线解析当前激活的 Provider。以下内容只在异常排查或特殊场景需要。

## Provider 解析顺序

1. **显式环境变量完整元组**（最高优先，跳过本软件配置）
2. **本软件已保存的 Provider 配置**（默认路径）

### 1. 显式环境变量（可选）

| 环境变量 | 必填 | 说明 |
|---------|------|------|
| `IART_GPT_IMAGE_BASE_URL` | 与 KEY 同时 | Provider Base URL（https://，如 `https://your-provider.example.com`） |
| `IART_GPT_IMAGE_API_KEY` | 与 BASE_URL 同时 | 该 Provider 的 API Key |
| `IART_GPT_IMAGE_MODEL` | 否 | Provider 原生模型名（默认用 `gpt-image-2`） |

三者必须构成完整元组；只设其一会被拒绝（不得只凭 Key 推导默认 host）。

### 2. 本软件已保存配置（默认）

配置目录（按优先级）：

1. `IART_STORAGE_ROOT` / `IART_DATA_ROOT` / `IARTS_DATA_ROOT` 环境变量指向的目录
2. 平台默认：
   - macOS: `~/Library/Application Support/IARTStudio/IARTStudio_PC`
   - Windows: `%LOCALAPPDATA%\IARTStudio\IARTStudio_PC`
   - Linux: `~/.local/share/IARTStudio/IARTStudio_PC`

其下 `config/` 内四个文件参与解析：

| 文件 | 作用 |
|------|------|
| `active-routes.json` | 模型 → 激活部署（单值） |
| `model-deployments.json` | 部署 → 连接 + Provider 原生模型名（remote_model_id） |
| `provider-connections.json` | 连接 → base_url / 协议 / 生命周期 / 凭证引用 |
| `provider-credentials.json` | 凭证明文（base64 混淆，0600） |

## 常见问题

**Q：报「没有激活的 Provider 部署」**
在本软件 Provider 设置中为 `gpt-image-2` 激活一个部署（切换激活或新建）。

**Q：报「safeStorage 加密无法解密」**
该 Provider 的 Key 由操作系统级安全存储加密，本软件未运行时读不出。两种解法：
- 按上表配置显式环境变量；
- 在本软件内重新保存该 Provider 的 Key（重存后若走本地混淆形态即可离线解析）。

**Q：报「凭证无效」（401/403）**
在本软件内更新该 Provider 的 Key 后重试。

**Q：依赖**
`python3`（标准库即可）与 `curl`；脚本在 macOS / Linux 的 bash 及 Windows git-bash 下运行。
