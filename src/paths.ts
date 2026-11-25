import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaToolError } from "./types.js";

export interface ResolvedInput {
  absolutePath: string;
  realPath: string;
  stats: Stats;
}

export interface PreparedOutput {
  absolutePath: string;
  existed: boolean;
}

function looksLikeUrl(value: string): boolean {
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

export function assertPathInput(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MediaToolError("INVALID_INPUT", `${label}必须是非空路径字符串。`);
  }
  if (value.includes("\0")) {
    throw new MediaToolError("INVALID_INPUT", `${label}包含无效的空字符。`);
  }
  if (looksLikeUrl(value)) {
    throw new MediaToolError(
      "URL_NOT_SUPPORTED",
      `${label}不接受 URL；请先下载到本机，再传入文件路径。`,
    );
  }
  return value;
}

export async function resolveInputFile(value: unknown): Promise<ResolvedInput> {
  const inputPath = path.resolve(assertPathInput(value, "输入路径"));

  let inputStats: Stats;
  try {
    inputStats = await stat(inputPath);
  } catch (error) {
    throw new MediaToolError("INPUT_NOT_FOUND", "输入文件不存在或无法访问。", {
      cause: error,
    });
  }

  if (!inputStats.isFile()) {
    throw new MediaToolError("INPUT_NOT_FILE", "输入路径必须是普通文件。");
  }

  try {
    await access(inputPath, fsConstants.R_OK);
  } catch (error) {
    throw new MediaToolError("INPUT_NOT_READABLE", "输入文件不可读。", {
      cause: error,
    });
  }

  let inputRealPath: string;
  try {
    inputRealPath = await realpath(inputPath);
  } catch (error) {
    throw new MediaToolError("INPUT_NOT_READABLE", "无法解析输入文件路径。", {
      cause: error,
    });
  }

  return {
    absolutePath: inputPath,
    realPath: inputRealPath,
    stats: inputStats,
  };
}

async function nearestExistingAncestor(targetPath: string): Promise<string> {
  let current = targetPath;

  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new MediaToolError(
          "OUTPUT_NOT_WRITABLE",
          "无法检查输出目录的可用性。",
          { cause: error },
        );
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new MediaToolError(
        "OUTPUT_NOT_WRITABLE",
        "找不到可用的输出目录父级。",
      );
    }
    current = parent;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function assertOutputLocation(
  inputStats: Stats,
  targetPath: string,
): Promise<void> {
  const ancestor = await nearestExistingAncestor(targetPath);

  let ancestorRealPath: string;
  let ancestorStats: Stats;
  try {
    ancestorRealPath = await realpath(ancestor);
    ancestorStats = await stat(ancestor);
    await access(ancestorRealPath, fsConstants.W_OK);
  } catch (error) {
    throw new MediaToolError("OUTPUT_NOT_WRITABLE", "输出目录不可写。", {
      cause: error,
    });
  }

  let homeRealPath: string;
  try {
    homeRealPath = await realpath(os.homedir());
  } catch {
    homeRealPath = path.resolve(os.homedir());
  }

  const insideHome = isWithin(homeRealPath, ancestorRealPath);
  const sameVolume = ancestorStats.dev === inputStats.dev;

  if (!insideHome && !sameVolume) {
    throw new MediaToolError(
      "OUTPUT_NOT_ALLOWED",
      "输出位置必须位于用户主目录内，或与输入文件位于同一卷。",
    );
  }
}

export async function prepareOutputFile(
  input: ResolvedInput,
  value: unknown,
  overwrite: boolean,
): Promise<PreparedOutput> {
  const outputPath = path.resolve(assertPathInput(value, "输出路径"));
  const parentDirectory = path.dirname(outputPath);

  await assertOutputLocation(input.stats, parentDirectory);

  let existed = false;
  try {
    const outputStats = await lstat(outputPath);
    existed = true;

    if (outputStats.isSymbolicLink()) {
      throw new MediaToolError(
        "OUTPUT_NOT_ALLOWED",
        "输出路径不能是符号链接。",
      );
    }
    if (!outputStats.isFile()) {
      throw new MediaToolError(
        "OUTPUT_NOT_ALLOWED",
        "输出路径已存在且不是普通文件。",
      );
    }

    const outputRealPath = await realpath(outputPath);
    const sameInode =
      input.stats.ino !== 0 &&
      outputStats.ino !== 0 &&
      outputStats.dev === input.stats.dev &&
      outputStats.ino === input.stats.ino;
    if (outputRealPath === input.realPath || sameInode) {
      throw new MediaToolError(
        "OUTPUT_NOT_ALLOWED",
        "输出路径不能与输入文件相同，也不能是输入文件的硬链接。",
      );
    }

    if (!overwrite) {
      throw new MediaToolError(
        "OUTPUT_EXISTS",
        "输出文件已存在；如确需覆盖，请传入 overwrite=true。",
      );
    }

    await access(outputPath, fsConstants.W_OK);
  } catch (error) {
    if (error instanceof MediaToolError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MediaToolError("OUTPUT_NOT_WRITABLE", "输出文件不可写。", {
        cause: error,
      });
    }
  }

  try {
    await mkdir(parentDirectory, { recursive: true });
    await access(parentDirectory, fsConstants.W_OK);
  } catch (error) {
    throw new MediaToolError("OUTPUT_NOT_WRITABLE", "无法创建或写入输出目录。", {
      cause: error,
    });
  }

  return {
    absolutePath: outputPath,
    existed,
  };
}

export async function prepareOutputDirectory(
  input: ResolvedInput,
  value: unknown,
): Promise<string> {
  const outputDirectory = path.resolve(assertPathInput(value, "输出目录"));
  const parentDirectory = path.dirname(outputDirectory);

  await assertOutputLocation(input.stats, outputDirectory);

  try {
    const existing = await lstat(outputDirectory);
    if (existing.isSymbolicLink()) {
      throw new MediaToolError(
        "OUTPUT_NOT_ALLOWED",
        "输出目录不能是符号链接。",
      );
    }
    throw new MediaToolError(
      "OUTPUT_EXISTS",
      "输出目录已存在；请换一个尚不存在的目录。",
    );
  } catch (error) {
    if (error instanceof MediaToolError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MediaToolError("OUTPUT_NOT_WRITABLE", "无法检查输出目录。", {
        cause: error,
      });
    }
  }

  try {
    await mkdir(parentDirectory, { recursive: true });
    await access(parentDirectory, fsConstants.W_OK);
    await mkdir(outputDirectory);
    await access(outputDirectory, fsConstants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MediaToolError(
        "OUTPUT_EXISTS",
        "输出目录已存在；请换一个尚不存在的目录。",
      );
    }
    throw new MediaToolError("OUTPUT_NOT_WRITABLE", "无法创建输出目录。", {
      cause: error,
    });
  }

  return outputDirectory;
}
