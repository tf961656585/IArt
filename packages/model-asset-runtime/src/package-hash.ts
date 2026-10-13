/**
 * 模型能力包目录聚合 sha512 与文件清单计算。
 *
 * 设计锚点：docs/model-assets/40-模型资产远端同步体系.md "包目录聚合 sha512 算法" 节。
 *
 * 本模块是打包侧（tooling/scripts/build-model-asset-packages.ts）的唯一算法实现，
 * 打包产物内的校验清单与该实现保持一致。
 *
 * 算法精确定义（spec 38）：
 * 1. 递归遍历包目录所有文件（不含子目录本身）
 * 2. 文件按相对路径（统一用 `/` 分隔符）字典序升序排列
 * 3. 对每个文件：计算 sha512(文件二进制内容) 得到 hex 字符串
 * 4. 聚合输入字符串：每文件拼接一行 `<relativePath>\n<sha512hex>\n`
 * 5. 聚合输出：sha512(聚合输入的 utf-8 编码) 的 hex 字符串
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 包内单个文件的校验条目。
 * 纯算法层输出，不依赖业务契约以保持算法模块零业务依赖。
 */
export interface PackageFileEntry {
  /** 相对于包目录的文件路径，统一用 `/` 分隔符。 */
  path: string;
  /** 该文件的 sha512 hex。 */
  sha512: string;
  /** 该文件字节数。 */
  size: number;
}

/** 包目录的聚合校验结果。 */
export interface PackageDirectoryManifest {
  /** 包内文件清单（按相对路径字典序升序）。 */
  files: PackageFileEntry[];
  /** 包目录的聚合 sha512 hex。 */
  sha512: string;
  /** 包目录的汇总字节数。 */
  size: number;
}

/** 将平台路径分隔符统一为 `/`。 */
const normalizeRelativePath = (absPath: string, rootDir: string): string => {
  const rel = relative(rootDir, absPath);
  return sep === "/" ? rel : rel.split(sep).join("/");
};

/** 计算单个文件的 sha512 hex。 */
export const computeFileSha512Hex = (filePath: string): string => {
  const content = readFileSync(filePath);
  return createHash("sha512").update(content).digest("hex");
};

/**
 * 递归收集目录下所有文件的绝对路径（不含目录本身）。
 * 不保证顺序——调用方负责排序。
 */
const collectFilePaths = (rootDir: string): string[] => {
  const results: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return results;
};

/**
 * 计算包目录的完整 manifest：文件清单 + 聚合 sha512 + 汇总 size。
 *
 * 严格遵循 spec 38 "包目录聚合 sha512 算法" 节。
 * 发布侧和客户端必须通过本函数计算聚合 hash。
 */
export const computePackageDirectoryManifest = (packageDir: string): PackageDirectoryManifest => {
  const filePaths = collectFilePaths(packageDir);
  const entries: PackageFileEntry[] = filePaths.map((absPath) => {
    const relativePath = normalizeRelativePath(absPath, packageDir);
    const stat = statSync(absPath);
    return {
      path: relativePath,
      sha512: computeFileSha512Hex(absPath),
      size: stat.size,
    };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const aggregateInput = entries.map((entry) => `${entry.path}\n${entry.sha512}\n`).join("");
  const aggregateSha512 = createHash("sha512").update(aggregateInput, "utf8").digest("hex");
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);

  return {
    files: entries,
    sha512: aggregateSha512,
    size: totalSize,
  };
};
