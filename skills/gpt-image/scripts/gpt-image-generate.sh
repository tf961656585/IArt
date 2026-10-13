#!/usr/bin/env bash
# gpt-image 文生图（t2i）：POST {base_url}/v1/images/generations
# Provider 与鉴权由 gpt_image_tool.py resolve-provider 从本软件已保存的配置离线解析。
# 不设请求超时、不自动重试；失败时打印错误并以非零退出码退出。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/gpt_image_tool.py"

usage() {
  cat <<'EOF'
用法: gpt-image-generate.sh --prompt "<描述>" [选项]

选项:
  --prompt <文本>        图像描述（必填）
  --size <WxH|auto>      尺寸，auto 或任意 宽x高（自动归一化到合规值，默认 auto）
  --quality <值>         low / medium / high / auto（默认 auto）
  --format <值>          png / jpeg / webp（默认 png）
  --background <值>      transparent / opaque / auto（默认 auto；transparent 需 png/webp）
  --output <目录>        输出目录（默认 ./gpt-image-output）
  -h, --help             显示本帮助
EOF
}

die() { echo "错误: $*" >&2; exit 2; }

PROMPT=""
SIZE="auto"
QUALITY="auto"
FORMAT="png"
BACKGROUND="auto"
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --size) SIZE="${2:-}"; shift 2 ;;
    --quality) QUALITY="${2:-}"; shift 2 ;;
    --format) FORMAT="${2:-}"; shift 2 ;;
    --background) BACKGROUND="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

[[ -n "$PROMPT" ]] || { usage >&2; echo >&2; die "缺少必填参数 --prompt"; }
case "$QUALITY" in auto|low|medium|high) ;; *) die "--quality 只允许 auto/low/medium/high" ;; esac
case "$FORMAT" in png|jpeg|webp) ;; *) die "--format 只允许 png/jpeg/webp" ;; esac
case "$BACKGROUND" in auto|transparent|opaque) ;; *) die "--background 只允许 auto/transparent/opaque" ;; esac
if [[ "$BACKGROUND" == "transparent" && "$FORMAT" != "png" && "$FORMAT" != "webp" ]]; then
  die "transparent 背景要求 --format 为 png 或 webp"
fi

command -v python3 >/dev/null 2>&1 || die "未找到 python3，本 skill 依赖 python3（标准库即可）"
command -v curl >/dev/null 2>&1 || die "未找到 curl"

# 1. 解析当前激活 Provider（离线，读本软件已保存配置）
eval "$(python3 "$TOOL" resolve-provider --model gpt-image-2)" || die "Provider 解析失败"

# 2. 尺寸归一化
NORM_SIZE="$(python3 "$TOOL" normalize-size --size "$SIZE")" || die "尺寸归一化失败"

# 3. 组装 JSON body
BODY="$(python3 "$TOOL" build-body-json \
  --remote-model "$REMOTE_MODEL_ID" \
  --prompt "$PROMPT" \
  --size "$NORM_SIZE" \
  --quality "$QUALITY" \
  --output-format "$FORMAT" \
  --background "$BACKGROUND")"

OUTPUT_DIR="${OUTPUT:-./gpt-image-output}"
mkdir -p "$OUTPUT_DIR"
# 时间戳 + PID + 随机串保证并行调用同秒启动也不撞名（秒级时间戳跨进程不唯一）
STEM="gpt-image-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)-$$-$RANDOM"
RESP="$(mktemp)"
trap 'rm -f "$RESP"' EXIT

echo "Provider: $PROVIDER_NAME | 模型: gpt-image-2 → $REMOTE_MODEL_ID | 尺寸: $NORM_SIZE | 质量: $QUALITY" >&2

# 4. 请求（无超时，不重试）
HTTP_CODE="$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST "$BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "$BODY")" || die "网络请求失败（Provider: $PROVIDER_NAME）"

# 5. 解析响应并保存
python3 "$TOOL" decode-response \
  --response-file "$RESP" \
  --http-code "$HTTP_CODE" \
  --output "$OUTPUT_DIR" \
  --stem "$STEM" \
  --format "$FORMAT"
