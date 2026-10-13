#!/usr/bin/env python3
"""gpt-image skill 共享工具（stdlib only）。

子命令：
  resolve-provider   从本软件已保存的 Provider 配置解析 gpt-image-2 当前激活部署，
                     输出可直接 eval 的 KEY=VALUE 行（BASE_URL/API_KEY/REMOTE_MODEL_ID/PROVIDER_NAME）。
  normalize-size     把 WxH 归一化到 openai-image 协议合法尺寸（16 倍数、边 ≤3840、
                     比例 ≤3:1、总像素 [655360, 8294400]），auto 原样通过。
  build-body-json    组装文生图 JSON body（model = remote_model_id）。
  prepare-input      图生图输入预处理：本地路径原样透传，URL / data URI 落临时文件。
  decode-response    解析上游响应：保存 b64_json / 下载 url，打印「图像已保存: <path>」。

解析链（对齐 docs/hub/skill-store.md 与 app 执行链）：
  显式环境变量完整元组 → active-routes.json → model-deployments.json
  → provider-connections.json → provider-credentials.json（base64 混淆还原）。
  每个模型只消费其 active deployment，不跨候选/跨 Provider 串用，不回退任何固定网关。
"""

import base64
import json
import os
import re
import shlex
import sys
import urllib.request

MODEL_ID = "gpt-image-2"
ADAPTER_ID = "openai-image-v1"

SIZE_MIN_PIXELS = 655360
SIZE_MAX_PIXELS = 8294400
SIZE_MAX_EDGE = 3840
SIZE_MAX_RATIO = 3
SIZE_MULTIPLE = 16

MASK_VISIBLE = 6


class SkillError(Exception):
    """用户可读的失败；消息直接透出给终端，退出码非零。"""


def log(message: str) -> None:
    print(message, file=sys.stderr)


def mask_key(key: str) -> str:
    visible = key[:MASK_VISIBLE]
    return f"{visible}... (len={len(key)})"


def read_json(path: str, label: str) -> dict:
    if not os.path.exists(path):
        raise SkillError(f"未找到{label}文件: {path}。请确认本软件已安装并至少运行过一次。")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        raise SkillError(f"读取{label}文件失败: {path}: {exc}")
    if not isinstance(data, dict):
        raise SkillError(f"{label}文件格式异常（顶层不是对象）: {path}")
    return data


def storage_root() -> str:
    for var in ("IART_STORAGE_ROOT", "IART_DATA_ROOT", "IARTS_DATA_ROOT"):
        value = os.environ.get(var, "").strip()
        if value:
            return value
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "IARTStudio", "IARTStudio_PC")
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(base, "IARTStudio", "IARTStudio_PC")
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return os.path.join(base, "IARTStudio", "IARTStudio_PC")


def normalize_base_url(raw: str) -> str:
    trimmed = raw.strip().rstrip("/")
    if not re.match(r"^https://", trimmed):
        raise SkillError(f"Provider base_url 必须是 https://，当前值: {raw!r}")
    return trimmed


def decode_credential(payload: str, provider_name: str) -> str:
    """把 provider-credentials.json 的 payload 还原为明文 Key。

    落盘形态两种：本地 base64 混淆（可直接还原）与 OS safeStorage 加密
    （app 未运行时无法解密）。后者必须作为明确错误态暴露，不能静默。
    """
    try:
        raw = base64.b64decode(payload, validate=False)
        text = raw.decode("utf-8")
    except Exception:
        raise SkillError(
            f"Provider「{provider_name}」的凭证由系统级安全存储（safeStorage）加密，"
            "本软件未运行时无法解密。请改用显式环境变量配置（见 SETUP.md），"
            "或在本软件内查看该 Provider 的 Key 后手动配置。"
        )
    key = text.strip()
    if len(key) < 8 or any(ch in key for ch in "\x00\r\n"):
        raise SkillError(
            f"Provider「{provider_name}」的凭证无法还原为可用 Key（内容异常）。"
            "请在本软件内重新保存该 Provider 的 Key，或改用显式环境变量配置（见 SETUP.md）。"
        )
    return key


def emit_provider(base_url: str, api_key: str, remote_model_id: str, provider_name: str) -> None:
    for key, value in (
        ("BASE_URL", base_url),
        ("API_KEY", api_key),
        ("REMOTE_MODEL_ID", remote_model_id),
        ("PROVIDER_NAME", provider_name),
    ):
        print(f"{key}={shlex.quote(value)}")


def resolve_from_storage(model_id: str) -> None:
    cfg_dir = os.path.join(storage_root(), "config")
    log(f"[resolve] 存储目录: {cfg_dir}")

    routes = read_json(os.path.join(cfg_dir, "active-routes.json"), "激活路由（active-routes）")
    deployment_id = (routes.get("activeRoutes") or {}).get(model_id)
    if not deployment_id:
        raise SkillError(
            f"模型 {model_id} 当前没有激活的 Provider 部署。"
            "请在本软件的 Provider 设置中为该模型激活一个部署后重试。"
        )

    deployments = read_json(os.path.join(cfg_dir, "model-deployments.json"), "模型部署（model-deployments）")
    deployment = next(
        (d for d in deployments.get("deployments", []) if d.get("deployment_id") == deployment_id),
        None,
    )
    if not deployment:
        raise SkillError(f"激活路由指向的部署不存在: {deployment_id}")
    connection_id = deployment.get("connection_id")
    remote_model_id = deployment.get("remote_model_id")
    if not connection_id or not remote_model_id:
        raise SkillError(f"部署 {deployment_id} 缺少 connection_id / remote_model_id")

    connections = read_json(os.path.join(cfg_dir, "provider-connections.json"), "Provider 连接（provider-connections）")
    connection = next(
        (c for c in connections.get("connections", []) if c.get("connection_id") == connection_id),
        None,
    )
    if not connection:
        raise SkillError(f"部署引用的连接不存在: {connection_id}")
    provider_name = connection.get("display_name") or connection_id
    if connection.get("protocol_adapter_id") != ADAPTER_ID:
        raise SkillError(
            f"模型 {model_id} 的激活部署绑定的是 {connection.get('protocol_adapter_id')} 协议，"
            "本 skill 只支持 openai-image 协议的 Provider。"
        )
    if connection.get("lifecycle") != "enabled":
        raise SkillError(f"Provider「{provider_name}」当前状态为 {connection.get('lifecycle')}，无法使用。请在本软件中启用后再试。")
    base_url_raw = connection.get("base_url")
    if not base_url_raw:
        raise SkillError(f"Provider「{provider_name}」缺少 base_url")
    base_url = normalize_base_url(base_url_raw)

    credential_ref = connection.get("credential_ref")
    if not connection.get("has_credential") or not credential_ref:
        raise SkillError(f"Provider「{provider_name}」未配置 API Key。请在本软件中配置后重试。")

    credentials = read_json(os.path.join(cfg_dir, "provider-credentials.json"), "Provider 凭证（provider-credentials）")
    entry = (credentials.get("entries") or {}).get(credential_ref)
    if not entry or not entry.get("payload"):
        raise SkillError(f"Provider「{provider_name}」的凭证条目缺失（{credential_ref}）。请在本软件中重新保存 Key。")
    api_key = decode_credential(entry["payload"], provider_name)

    log(f"[resolve] Provider: {provider_name} ({base_url})")
    log(f"[resolve] 模型映射: {model_id} → {remote_model_id}")
    log(f"[resolve] Key: {mask_key(api_key)}")
    emit_provider(base_url, api_key, remote_model_id, provider_name)


def cmd_resolve_provider(args) -> int:
    env_base = os.environ.get("IART_GPT_IMAGE_BASE_URL", "").strip()
    env_key = os.environ.get("IART_GPT_IMAGE_API_KEY", "").strip()
    if env_base or env_key:
        if not env_base or not env_key:
            raise SkillError("显式环境变量配置不完整：IART_GPT_IMAGE_BASE_URL 与 IART_GPT_IMAGE_API_KEY 必须同时提供。")
        remote = os.environ.get("IART_GPT_IMAGE_MODEL", "").strip() or args.model
        base_url = normalize_base_url(env_base)
        log("[resolve] 使用显式环境变量配置（跳过本软件已保存的 Provider）")
        log(f"[resolve] Provider: explicit-env ({base_url})")
        log(f"[resolve] 模型映射: {args.model} → {remote}")
        log(f"[resolve] Key: {mask_key(env_key)}")
        emit_provider(base_url, env_key, remote, "explicit-env")
        return 0
    resolve_from_storage(args.model)
    return 0


# ---------------------------------------------------------------------------
# normalize-size
# ---------------------------------------------------------------------------

def round_to_multiple(value: float) -> int:
    rounded = int(round(value / SIZE_MULTIPLE)) * SIZE_MULTIPLE
    return max(SIZE_MULTIPLE, min(SIZE_MAX_EDGE, rounded))


def normalize_size_pair(width: int, height: int) -> tuple:
    width = round_to_multiple(width)
    height = round_to_multiple(height)
    notes = []

    if width > SIZE_MAX_RATIO * height:
        width = round_to_multiple(SIZE_MAX_RATIO * height)
        notes.append(f"宽高比超出 {SIZE_MAX_RATIO}:1，宽边收紧到 {width}")
    if height > SIZE_MAX_RATIO * width:
        height = round_to_multiple(SIZE_MAX_RATIO * width)
        notes.append(f"宽高比超出 {SIZE_MAX_RATIO}:1，高边收紧到 {height}")

    total = width * height
    if total < SIZE_MIN_PIXELS or total > SIZE_MAX_PIXELS:
        target = SIZE_MIN_PIXELS if total < SIZE_MIN_PIXELS else SIZE_MAX_PIXELS
        scale = (target / total) ** 0.5
        width = round_to_multiple(width * scale)
        height = round_to_multiple(height * scale)
        notes.append(f"总像素 {total} 超出 [{SIZE_MIN_PIXELS}, {SIZE_MAX_PIXELS}]，按比例缩放到 {width}x{height}")

    for _ in range(4):
        total = width * height
        if SIZE_MIN_PIXELS <= total <= SIZE_MAX_PIXELS:
            break
        scale = (SIZE_MIN_PIXELS / total) ** 0.5 if total < SIZE_MIN_PIXELS else (SIZE_MAX_PIXELS / total) ** 0.5
        width = round_to_multiple(width * scale)
        height = round_to_multiple(height * scale)
        notes.append(f"像素边界二次修正到 {width}x{height}")

    return width, height, notes


def cmd_normalize_size(args) -> int:
    raw = args.size.strip().lower()
    if raw in ("", "auto"):
        print("auto")
        return 0
    match = re.fullmatch(r"(\d+)\s*[xX×]\s*(\d+)", raw)
    if not match:
        raise SkillError(f"无法解析尺寸: {args.size!r}（合法格式: auto 或 宽x高，如 2048x1360）")
    width, height, notes = normalize_size_pair(int(match.group(1)), int(match.group(2)))
    for note in notes:
        log(f"[size] {note}")
    print(f"{width}x{height}")
    return 0


# ---------------------------------------------------------------------------
# build-body-json
# ---------------------------------------------------------------------------

def cmd_build_body(args) -> int:
    body = {"model": args.remote_model, "prompt": args.prompt}
    if args.size and args.size != "auto":
        body["size"] = args.size
    if args.quality and args.quality != "auto":
        body["quality"] = args.quality
    if args.output_format and args.output_format != "auto":
        body["output_format"] = args.output_format
    if args.background and args.background != "auto":
        body["background"] = args.background
    if args.moderation and args.moderation != "auto":
        body["moderation"] = args.moderation
    print(json.dumps(body, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------------
# prepare-input（图生图输入预处理）
# ---------------------------------------------------------------------------

DATA_URI_RE = re.compile(r"^data:([\w.+-]+/[\w.+-]+)?;base64,(.*)$", re.DOTALL)


def guess_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext, "")


def fetch_remote_into(url: str, handle) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "iart-gpt-image-skill/2.0"})
    # 不设超时：与生成请求同一治理口径，远端时长不可预估。
    with urllib.request.urlopen(request) as response:
        handle.write(response.read())


def fetch_remote(url: str, target_path: str) -> None:
    with open(target_path, "wb") as handle:
        fetch_remote_into(url, handle)


def cmd_prepare_input(args) -> int:
    source = args.image.strip()
    if not source:
        raise SkillError("图片输入为空")

    data_uri = DATA_URI_RE.match(source)
    if data_uri:
        mime = (data_uri.group(1) or "image/png").lower()
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "png")
        target = os.path.join(args.temp_dir, f"input-{args.index}.{ext}")
        with open(target, "wb") as handle:
            handle.write(base64.b64decode(data_uri.group(2)))
        print(f"{target}\t{mime}")
        return 0

    if re.match(r"^https?://", source, re.IGNORECASE):
        ext = os.path.splitext(source.split("?")[0])[1].lower().lstrip(".")
        target = os.path.join(args.temp_dir, f"input-{args.index}.{ext or 'png'}")
        try:
            fetch_remote(source, target)
        except Exception as exc:
            raise SkillError(f"下载输入图片失败: {source}: {exc}")
        print(f"{target}\t{guess_mime(target)}")
        return 0

    if os.path.isfile(source):
        print(f"{os.path.abspath(source)}\t{guess_mime(source)}")
        return 0

    raise SkillError(f"输入图片不存在或不可读: {source}")


# ---------------------------------------------------------------------------
# decode-response
# ---------------------------------------------------------------------------

SAVE_EXCLUSIVE_MAX_ATTEMPTS = 999


def save_exclusive(target: str, write_body) -> str:
    """独占创建目标文件后写入；同名已存在时自动追加 -2、-3… 序号，绝不静默覆盖。

    O_EXCL 保证并发进程争用同一文件名时只有一方成功，其余方拿到递增名，
    消除「检查-写入」窗口内的跨进程互相覆盖。写入失败时清理占位文件后原样抛出。
    返回最终落盘路径。
    """
    root, ext = os.path.splitext(target)
    candidate = target
    serial = 1
    while True:
        try:
            fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if serial >= SAVE_EXCLUSIVE_MAX_ATTEMPTS:
                raise SkillError(f"输出文件名冲突且可用序号耗尽: {target}")
            serial += 1
            candidate = f"{root}-{serial}{ext}"
            log(f"[response] 目标已存在，改用: {os.path.basename(candidate)}")
    try:
        with os.fdopen(fd, "wb") as handle:
            write_body(handle)
    except Exception:
        try:
            os.unlink(candidate)
        except OSError:
            pass
        raise
    return candidate


def cmd_decode_response(args) -> int:
    with open(args.response_file, "rb") as handle:
        raw = handle.read()
    if not raw.strip():
        raise SkillError(f"上游返回空响应（HTTP {args.http_code}）")

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        snippet = raw[:200].decode("utf-8", errors="replace")
        raise SkillError(f"上游返回非 JSON 响应（HTTP {args.http_code}）: {snippet}")

    if isinstance(payload, dict) and payload.get("error"):
        error = payload["error"]
        if isinstance(error, dict):
            code = error.get("code") or ""
            message = error.get("message") or json.dumps(error, ensure_ascii=False)
        else:
            code, message = "", str(error)
        log(f"上游返回错误（HTTP {args.http_code}）{code}: {message}".strip())
        return 3

    if args.http_code and not str(args.http_code).startswith("2"):
        snippet = raw[:200].decode("utf-8", errors="replace")
        raise SkillError(f"上游返回 HTTP {args.http_code}: {snippet}")

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        raise SkillError(f"响应中没有 data 数组（HTTP {args.http_code}）: {raw[:200].decode('utf-8', errors='replace')}")

    revised = [item.get("revised_prompt") for item in data if isinstance(item, dict) and item.get("revised_prompt")]
    os.makedirs(args.output, exist_ok=True)
    saved = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            log(f"[response] data[{index}] 不是对象，跳过")
            continue
        stem = f"{args.stem}-{index + 1}" if len(data) > 1 else args.stem
        target = os.path.join(args.output, f"{stem}.{args.format}")
        b64 = item.get("b64_json")
        url = item.get("url")
        try:
            if b64:
                payload = base64.b64decode(b64)
                final = save_exclusive(target, lambda handle: handle.write(payload))
            elif url:
                final = save_exclusive(target, lambda handle: fetch_remote_into(url, handle))
            else:
                log(f"[response] data[{index}] 无 b64_json / url，跳过")
                continue
        except Exception as exc:
            raise SkillError(f"保存第 {index + 1} 张图片失败: {exc}")
        print(f"图像已保存: {os.path.abspath(final)}")
        saved.append(final)

    if not saved:
        raise SkillError("响应中没有可保存的图片数据")
    if revised:
        log(f"[response] revised_prompt: {revised[0]}")
    return 0


# ---------------------------------------------------------------------------
# arg parsing
# ---------------------------------------------------------------------------

def build_parser() -> "argparse.ArgumentParser":
    import argparse

    parser = argparse.ArgumentParser(description="gpt-image skill 共享工具")
    sub = parser.add_subparsers(dest="command", required=True)

    resolve = sub.add_parser("resolve-provider", help="解析当前激活 Provider")
    resolve.add_argument("--model", default=MODEL_ID)
    resolve.set_defaults(func=cmd_resolve_provider)

    size = sub.add_parser("normalize-size", help="归一化尺寸")
    size.add_argument("--size", required=True)
    size.set_defaults(func=cmd_normalize_size)

    body = sub.add_parser("build-body-json", help="组装文生图 JSON body")
    body.add_argument("--remote-model", required=True)
    body.add_argument("--prompt", required=True)
    body.add_argument("--size", default="auto")
    body.add_argument("--quality", default="auto")
    body.add_argument("--output-format", default="auto")
    body.add_argument("--background", default="auto")
    body.add_argument("--moderation", default="auto")
    body.set_defaults(func=cmd_build_body)

    prepare = sub.add_parser("prepare-input", help="预处理图生图输入")
    prepare.add_argument("--image", required=True)
    prepare.add_argument("--index", type=int, default=0)
    prepare.add_argument("--temp-dir", required=True)
    prepare.set_defaults(func=cmd_prepare_input)

    decode = sub.add_parser("decode-response", help="解析并保存响应图片")
    decode.add_argument("--response-file", required=True)
    decode.add_argument("--http-code", default="")
    decode.add_argument("--output", required=True)
    decode.add_argument("--stem", required=True)
    decode.add_argument("--format", default="png")
    decode.set_defaults(func=cmd_decode_response)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except SkillError as exc:
        log(f"错误: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
