#!/usr/bin/env bash
# gpt-image 图生图（i2i）：POST {base_url}/v1/images/edits（multipart）
# 输入支持本地路径 / HTTP(S) URL / data URI；URL 与 data URI 自动落到临时文件。
# Provider 与鉴权由 gpt_image_tool.py resolve-provider 从本软件已保存的配置离线解析。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/gpt_image_tool.py"

usage() {
  cat <<'EOF'
用法: gpt-image-edit.sh --prompt "<编辑指令>" --image <图片> [--image <图片> ...] [选项]

选项:
  --prompt <文本>        编辑指令（必填）
  --image <路径|URL|data URI>  参考图，至少 1 张、最多 16 张（可重复传参）
  --size <WxH|auto>      尺寸，auto 或 宽x高（默认 auto；上游若拒绝自由尺寸按参数错误提示）
  --quality <值>         low / medium / high / auto（默认 auto）
  --moderation <值>      auto / low（默认 auto）
  --output <目录>        输出目录（默认 ./gpt-image-output）
  -h, --help             显示本帮助
EOF
}

die() { echo "错误: $*" >&2; exit 2; }

PROMPT=""
SIZE="auto"
QUALITY="auto"
MODERATION="auto"
OUTPUT=""
IMAGES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --image) IMAGES+=("${2:-}"); shift 2 ;;
    --size) SIZE="${2:-}"; shift 2 ;;
    --quality) QUALITY="${2:-}"; shift 2 ;;
    --moderation) MODERATION="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

[[ -n "$PROMPT" ]] || { usage >&2; echo >&2; die "缺少必填参数 --prompt"; }
[[ ${#IMAGES[@]} -ge 1 ]] || die "缺少 --image（至少 1 张参考图）"
[[ ${#IMAGES[@]} -le 16 ]] || die "参考图最多 16 张（当前 ${#IMAGES[@]} 张）"
case "$QUALITY" in auto|low|medium|high) ;; *) die "--quality 只允许 auto/low/medium/high" ;; esac
case "$MODERATION" in auto|low) ;; *) die "--moderation 只允许 auto/low" ;; esac

command -v python3 >/dev/null 2>&1 || die "未找到 python3，本 skill 依赖 python3（标准库即可）"
command -v curl >/dev/null 2>&1 || die "未找到 curl"

# 1. 解析当前激活 Provider（离线，读本软件已保存配置）
eval "$(python3 "$TOOL" resolve-provider --model gpt-image-2)" || die "Provider 解析失败"

# 2. 尺寸归一化
NORM_SIZE="$(python3 "$TOOL" normalize-size --size "$SIZE")" || die "尺寸归一化失败"

# 3. 预处理输入（URL / data URI 落临时文件，退出时清理）
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR" "$RESP_FILE"' EXIT
RESP_FILE="$(mktemp)"

CURL_ARGS=( -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "$BASE_URL/v1/images/edits"
  -H "Authorization: Bearer $API_KEY"
  -F "model=$REMOTE_MODEL_ID"
  -F "prompt=$PROMPT" )
if [[ "$NORM_SIZE" != "auto" ]]; then CURL_ARGS+=( -F "size=$NORM_SIZE" ); fi
if [[ "$QUALITY" != "auto" ]]; then CURL_ARGS+=( -F "quality=$QUALITY" ); fi
if [[ "$MODERATION" != "auto" ]]; then CURL_ARGS+=( -F "moderation=$MODERATION" ); fi

INDEX=0
for IMAGE in "${IMAGES[@]}"; do
  PREPARED="$(python3 "$TOOL" prepare-input --image "$IMAGE" --index "$INDEX" --temp-dir "$TEMP_DIR")" \
    || die "第 $((INDEX + 1)) 张输入图片处理失败"
  PATH_PART="${PREPARED%%$'\t'*}"
  MIME_PART="${PREPARED##*$'\t'}"
  if [[ -n "$MIME_PART" ]]; then
    CURL_ARGS+=( -F "image[]=@${PATH_PART};type=${MIME_PART}" )
  else
    CURL_ARGS+=( -F "image[]=@${PATH_PART}" )
  fi
  INDEX=$((INDEX + 1))
done

OUTPUT_DIR="${OUTPUT:-./gpt-image-output}"
mkdir -p "$OUTPUT_DIR"
# 时间戳 + PID + 随机串保证并行调用同秒启动也不撞名（秒级时间戳跨进程不唯一）
STEM="gpt-image-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)-$$-$RANDOM"

echo "Provider: $PROVIDER_NAME | 模型: gpt-image-2 → $REMOTE_MODEL_ID | 输入图: ${#IMAGES[@]} 张 | 尺寸: $NORM_SIZE" >&2

# 4. 请求（无超时，不重试）
HTTP_CODE="$(curl "${CURL_ARGS[@]}")" || die "网络请求失败（Provider: $PROVIDER_NAME）"

# 5. 解析响应并保存（edits 产物默认 png）
python3 "$TOOL" decode-response \
  --response-file "$RESP_FILE" \
  --http-code "$HTTP_CODE" \
  --output "$OUTPUT_DIR" \
  --stem "$STEM" \
  --format png
