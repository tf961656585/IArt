---
name: gpt-image
description: |
  使用本软件（IARTStudio）已保存的 Provider 配置，离线调用当前激活的 gpt-image-2 部署完成图像生成与编辑。
  当用户提到"生图"、"生成图片"、"画图"、"画一张"、"AI 画图"、"图片生成"、"生成图像"、"文生图"、"图生图"、
  "图片编辑"、"编辑图片"、"修改图片"、"gpt-image"、"generate image"、"create image"、"edit image"时触发。
  也适用于用户描述一个视觉场景并希望生成对应图片的场景，例如"帮我画一个..."、"我想要一张...的图"。
  当用户提供图片时，自动路由到图生图（编辑）模式；无图片时走文生图模式。
  无需本软件处于运行状态：Provider、Base URL、模型映射与鉴权均从本机已保存配置解析。
---

# GPT Image 生图工作流

本 skill 消费本软件已保存的 Provider 配置（激活部署），在不依赖软件运行的状态下调用
gpt-image-2 当前激活的 Provider 完成生图与改图。只使用一个数据源：模型 `gpt-image-2`
的 active deployment（含其 Provider base_url、模型映射 remote_model_id 与凭证），
不跨 Provider 串用、不回退任何固定网关。

支持两种模式：
1. **文生图**（无图片输入）：`POST {base_url}/v1/images/generations`（JSON）
2. **图生图**（有图片输入）：`POST {base_url}/v1/images/edits`（multipart）

脚本位于 `$SCRIPT_DIR/scripts/`（与安装位置无关的相对定位）。agent 调用脚本执行请求，
**不直接拼接 curl**。

---

## 第一步：Provider 解析（自动，无需人工介入）

脚本按以下顺序自动解析，任何一步失败都会给出明确中文错误：

1. **显式环境变量完整元组**（`IART_GPT_IMAGE_BASE_URL` + `IART_GPT_IMAGE_API_KEY`，
   可选 `IART_GPT_IMAGE_MODEL`）→ 同时设置时直连，跳过本软件配置
2. **本软件已保存的 Provider 配置**：按
   `active-routes.json → model-deployments.json → provider-connections.json → provider-credentials.json`
   解析 `gpt-image-2` 的激活部署，凭证自动还原（base64 混淆形态可直接解出）
3. 均不可用 → 报错退出（含指引：无激活部署时去软件 Provider 设置激活；safeStorage
   加密凭证或环境变量方案见 `SETUP.md`）

**正常使用无需检查 Provider**。只有脚本报错时才按错误信息引导用户。

---

## 第二步：路由决策

| 用户意图 | 关键信号 | 路由目标 | 脚本 |
|---------|---------|---------|------|
| 纯文本描述生成图 | 无图片输入，只有文字描述 | 文生图 | `gpt-image-generate.sh` |
| 上传图片并修改/编辑 | 有图片文件输入 | 图生图 | `gpt-image-edit.sh` |

1. 用户提供了图片（文件路径、URL、粘贴图片、data URI） → **图生图模式**
2. 无图片输入 → **文生图模式**
3. 不确定时，**简短询问**用户（一句话，不带选项列表）
4. **目标是把图放进 IARTStudio 画布/项目的场景不属于本 skill**（本 skill 的产物只是磁盘上的
   文件，不进画布）：要成为项目资产、在画布上查看、被画布里的生成引用时，改走 `iart-cli` skill
   （其中的 `asset import` 命令可导入本地文件，也可由用户在画布中拖入文件）。

---

## 第三步：参数组装

### 3.1 文生图参数

| 参数 | 必填 | 默认值 | 可选值 | 说明 |
|-----|------|-------|-------|------|
| prompt | 是 | - | 自由文本 | 图像描述，英文效果最佳 |
| size | 否 | auto | auto 或任意 宽x高（如 2048x1360） | 约束见「尺寸选择指南」，不合规输入由脚本自动修正 |
| quality | 否 | auto | auto, low, medium, high | 图像质量 |
| format | 否 | png | png, jpeg, webp | 输出格式 |
| background | 否 | auto | auto, transparent, opaque | transparent 为 preview 阶段支持，且要求 png/webp |

#### 尺寸选择指南（像素预算 × 比例）

size 不限于固定枚举，任意满足 openai-image 协议约束的 宽x高 都可用：

1. 宽高两边均为 16 的倍数
2. 最大边长 ≤ 3840
3. 长边 / 短边 ≤ 3:1
4. 总像素 ∈ [655360, 8294400]

agent 按「总像素预算 × 比例」推导尺寸：预算档位 1K ≈ 1,048,576 像素、2K ≈ 4,194,304 像素、
4K ≈ 8,294,400 像素；给定预算 P 与比例 r=长/短，短边 ≈ √(P/r)、长边 ≈ 短边×r，各自取 16 倍数。
**输入近似值即可，脚本会自动归一化到最近合规值**（stderr 会打印修正记录）。

常见组合参考（实际以脚本归一化结果为准）：

| 预算 | 1:1 | 3:2 | 16:9 | 3:1 |
|------|-----|-----|------|-----|
| 1K | 1024x1024 | 1248x832 | 1360x768 | 1776x592 |
| 2K | 2048x2048 | 2496x1664 | 2720x1536 | 3552x1184 |
| 4K | 2880x2880 | 3520x2352 | 3840x2160 | 3840x1280 |

竖版比例把宽高对调即可（如 2:3 → 1664x2496）。

### 3.2 图生图参数

| 参数 | 必填 | 默认值 | 说明 |
|-----|------|------|------|
| prompt | 是 | - | 编辑指令 |
| image | 是 | - | 图片输入（至少 1 张、最多 16 张，可重复传参） |
| size | 否 | auto | 同文生图；上游若拒绝 edits 侧自由尺寸，按参数错误处理并提示改用 auto |
| quality | 否 | auto | 同文生图 |
| moderation | 否 | auto | 内容审核严格程度：auto（标准）/ low（宽松） |

图片输入支持多种格式，脚本自动处理转换：
- 本地文件路径：直接使用
- HTTP/HTTPS URL：脚本自动下载到临时文件
- Data URI：脚本自动解码到临时文件

### 3.3 Prompt 优化

在组装参数时，对用户描述做以下处理：

1. **中文描述自动翻译**：如果用户用中文描述，翻译为英文后作为 prompt
2. **补充细节**：如果用户描述过于简短（少于10个词），适当补充构图、风格、光影等细节
3. **不改变意图**：翻译和补充不得改变用户的原始意图，只补充技术细节

示例：
- 用户说 "一只猫在屋顶上" → prompt: "A cat sitting on a rooftop, detailed, natural lighting"
- 用户说 "赛博朋克风格的城市夜景" → prompt: "Cyberpunk style city nightscape, neon lights, rain-soaked streets, futuristic architecture, atmospheric, high detail"

---

## 第四步：调用脚本执行

### 文生图

```bash
bash $SCRIPT_DIR/scripts/gpt-image-generate.sh \
  --prompt "<优化后的prompt>" \
  --size <尺寸> \
  --quality <质量> \
  --format <格式> \
  --output <输出目录>
```

### 图生图

```bash
bash $SCRIPT_DIR/scripts/gpt-image-edit.sh \
  --prompt "<编辑指令>" \
  --image <图片路径1> \
  [--image <图片路径2> ...] \
  --size <尺寸> \
  --quality <质量> \
  --output <输出目录>
```

### 脚本行为

- **Provider 解析自动完成**：按 显式环境变量完整元组 → 本软件已保存配置（激活部署）→ 报错
  的顺序判定，无需 agent 手动选择。
- **单候选，无 fallback 链**：只使用 `gpt-image-2` 当前激活部署对应的 Provider 与凭证；
  失败时如实报错，不切换到其他 Provider 或网关。
- **模型名映射自动完成**：请求 body 的 `model` 字段由脚本填入激活部署的 `remote_model_id`
  （Provider 原生模型名），agent 无需关心。
- **不设超时**：脚本不设请求超时（生图时长因模型与参数组合差异极大）。
- **不自动重试**：任何失败直接报告，由 agent 判断是否调整参数后重发。
- 响应中包含 `b64_json` 时自动解码保存，包含 `url` 时自动下载。
- 输出文件名格式：`gpt-image-{北京时间时间戳}-{pid}-{随机串}.{format}`（多图带序号）。
  时间戳 + PID + 随机串保证每次调用跨进程唯一：并行运行多个脚本实例（含 `&` + wait 后台并发）
  指向同一 `--output` 目录也不会互相覆盖，无需为并行任务分配独立输出目录。
- 写盘前独占创建（O_EXCL）：目标文件已存在时自动追加序号（`-2`、`-3`…）并在 stderr 留痕，
  任何情况下不静默覆盖已有文件。
- 临时文件（URL 下载、data URI 解码）在脚本退出时自动清理。

### 错误处理

脚本失败时，根据输出向用户说明：
- 「没有激活的 Provider 部署」→ 引导用户在本软件 Provider 设置中为 gpt-image-2 激活一个部署
- 「safeStorage 加密无法解密」→ 该 Provider 的 Key 由系统级安全存储保护，需按 `SETUP.md`
  用环境变量显式配置，或在本软件内查看 Key 后手动配置
- 401/403：凭证无效或过期 → 引导用户在本软件内更新该 Provider 的 Key
- 429：速率限制 → 提示稍后重试
- 400：参数错误 → 检查并修正参数（edits 侧自由尺寸被拒绝时改用 `--size auto`）
- 413：图片过大 → 提示压缩或缩小图片（参考图上限 50 MB）
- 网络失败：说明 Provider 地址，提示检查网络

---

## 第五步：结果展示

生成成功后，必须完成以下两件事：

1. **内联展示图片**：用 Read 工具读取脚本输出的保存路径，让用户在对话中直接看到生成结果。
2. **明确报告路径**：向用户输出完整的图片保存路径，方便用户后续使用。

脚本成功时对每张图输出一行 `图像已保存: /path/to/file.png`，从中提取路径即可。

---

## 禁止事项

- 禁止生成违法、色情、暴力等违规内容
- 禁止在日志或输出中暴露完整 API Key（脚本只输出前 6 位掩码）
- 禁止静默失败——任何错误都必须告知用户
- 禁止绕过脚本直接拼接 curl 命令，所有请求必须通过脚本执行
- 禁止将用户的原始描述翻译为与用户意图不同的 prompt
- 禁止使用模型 alias——产品模型统一用 `model_id`：`gpt-image-2`；Provider 原生模型名
  （remote_model_id）由激活部署决定，agent 不手工指定
- 禁止在候选外回退任何固定网关，或把一个 Provider 的 Key 用到另一个 Provider
- 禁止给脚本加请求超时或自动重试
