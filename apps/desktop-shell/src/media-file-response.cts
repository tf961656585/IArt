/**
 * Media File Response — 本地媒体文件的 HTTP 响应构建器（共享模块）
 *
 * 从 desktop-shell-bootstrap 提取，供两个协议处理器复用：
 * - local-media://（项目 media/ 目录，scope 经 coordinator 解析）
 * - package-media://（包文件夹，packageId 经包管理注册表解析）
 *
 * 支持 HTTP Range：Chromium <video> 媒体栈依赖 Range/206 分段读取 mp4 moov 原子，
 * 仅返回 200 全量会被判定为不可 seek，触发 onError 后视频静默回退到缩略图。
 * 无 Range 头时维持 200 全量；有 Range 头时返回 206 + Content-Range + 切片流。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { net } from "electron";

/**
 * 协商缓存辅助：同一 fileKey 的文件可能被同路径覆盖写
 * （thumbnail 同路径重生成），
 * 因此不走长 max-age，统一弱 ETag（size-mtimeMs）+ If-None-Match：
 * <img> 重新加载时浏览器发条件请求，文件未变返回 304，免去重新读盘+解码。
 */
const matchesIfNoneMatch = (headerValue: string | null, etag: string): boolean => {
  if (headerValue === null) return false;
  const stripWeakPrefix = (value: string) => value.trim().replace(/^W\//, "");
  const target = stripWeakPrefix(etag);
  return headerValue
    .split(",")
    .map(stripWeakPrefix)
    .some((candidate) => candidate === "*" || candidate === target);
};

export type ParsedRange =
  | { readonly kind: "none" } // 无 Range 头或格式无法识别 → 调用方按无 Range 返回 200
  | { readonly kind: "bytes"; readonly start: number; readonly end: number } // 合法 → 206
  | { readonly kind: "unsatisfiable" }; // 格式合法但越界 → 416

/**
 * 解析 Range 请求头，只取第一段（Chromium 媒体栈不发多段 Range）。
 * start/end 为闭区间字节偏移，与 HTTP Content-Range 及 fs.createReadStream 的 end 语义一致。
 * end 越上界自动截断到 size-1（属正常修正，非错误）。
 */
const parseRangeHeader = (headerValue: string | null, size: number): ParsedRange => {
  if (headerValue === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (match === null) return { kind: "none" };
  // noUncheckedIndexedAccess 下捕获组为 string | undefined；正则已保证命中，
  // ?? "" 把 undefined 收窄为合法 string（Number.parseInt("") === NaN 已被下游拦截）。
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  if (startStr === "" && endStr === "") return { kind: "none" }; // bytes=- 非法
  let start: number;
  let end: number;
  if (startStr === "") {
    // bytes=-N：取最后 N 字节的后缀范围
    const suffixLen = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { kind: "none" };
    start = size > suffixLen ? size - suffixLen : 0;
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return { kind: "none" };
    if (start >= size) return { kind: "unsatisfiable" };
    end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
    if (!Number.isFinite(end) || end < start) return { kind: "none" };
    if (end >= size) end = size - 1; // 越上界自动截断，非错误
  }
  return { kind: "bytes", start, end };
};

/**
 * 按扩展名推断 Content-Type。net.fetch(file://) 原本依赖 Chromium 按扩展名推断，
 * 但 Range 响应改用 fs 切片（无 mime 信息），必须显式设置，
 * 否则浏览器把 206 响应当二进制流，<video> 仍无法解码。
 */
const inferContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".m4v":
      return "video/x-m4v";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
};

/**
 * 命中文件时构造带缓存语义的响应；文件不存在返回 null（由调用方走 file_missing）。
 * statSync 合并了原先的 existsSync，避免重复 syscall。
 */
export const buildMediaFileResponse = async (
  filePath: string,
  request: Request,
): Promise<Response | null> => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": "no-cache", ETag: etag },
    });
  }
  const contentType = inferContentType(filePath);
  const size = stat.size;
  const range = parseRangeHeader(request.headers.get("range"), size);

  if (range.kind === "bytes") {
    const start = range.start;
    const end = range.end;
    const contentLength = end - start + 1;
    // 切片读入 Buffer 作为响应体。fs.createReadStream 返回的 Node ReadStream 与 fetch
    // 需要的 Web ReadableStream 存在 lib 类型不一致（done 时 value 可选性差异），
    // 强转需逃生口；本地 fs 切片读取极快且段不大，直接 Buffer 规避类型不兼容。
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(contentLength);
      fs.readSync(fd, buffer, 0, contentLength, start);
      return new Response(buffer, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(contentLength),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
          ETag: etag,
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  if (range.kind === "unsatisfiable") {
    // Range 请求但越界（start >= size）：按 RFC 7233 返回 416 + Content-Range: bytes */size
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
        // 416 属可启发式缓存状态码，禁缓存避免文件变化后 stale 416。
        "Cache-Control": "no-store",
      },
    });
  }

  // 无 Range 或格式无法识别：200 全量 + Accept-Ranges 广告可 Range。
  // net.fetch 返回的 Response headers 不可就地修改，需重建 Response 附加缓存头；
  // body 流原样透传，不引入额外读盘拷贝。
  const upstream = await net.fetch(`file://${filePath}`);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("Cache-Control", "no-cache");
  responseHeaders.set("ETag", etag);
  responseHeaders.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};
