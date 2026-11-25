import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MediaToolError,
  type MediaBinaryName,
  type MediaBinaries,
} from "./types.js";

export interface BinaryResolveOptions {
  platform?: NodeJS.Platform;
  envDir?: string | undefined;
  pathEnv?: string;
  commonDirs?: string[];
}

export function getInstallCommand(platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "brew install ffmpeg";
    case "win32":
      return "winget install Gyan.FFmpeg";
    case "linux":
      return "Ubuntu/Debian: sudo apt install ffmpeg；Fedora: sudo dnf install ffmpeg；Arch: sudo pacman -S ffmpeg";
    default:
      return "请安装 FFmpeg，并确保 ffmpeg 与 ffprobe 位于 PATH 中。";
  }
}

function defaultCommonDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
  }
  if (platform === "win32") {
    return [
      "C:\\ffmpeg\\bin",
      "C:\\Program Files\\ffmpeg\\bin",
      path.join(os.homedir(), "ffmpeg", "bin"),
    ];
  }
  return ["/usr/local/bin", "/usr/bin", "/snap/bin", "/opt/ffmpeg/bin"];
}

function executableNames(name: MediaBinaryName, platform: NodeJS.Platform) {
  return platform === "win32" ? [`${name}.exe`, name] : [name];
}

async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }
    await access(
      candidate,
      platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export async function findMediaBinaries(
  options: BinaryResolveOptions = {},
): Promise<MediaBinaries | null> {
  const platform = options.platform ?? process.platform;
  const envDir =
    options.envDir === undefined
      ? process.env.MATECLAW_FFMPEG_PATH
      : options.envDir;
  const pathEnv =
    options.pathEnv === undefined ? (process.env.PATH ?? "") : options.pathEnv;
  const commonDirs =
    options.commonDirs === undefined
      ? defaultCommonDirs(platform)
      : options.commonDirs;
  const pathSeparator = platform === "win32" ? ";" : ":";

  const directories = [
    ...(envDir?.trim() ? [envDir.trim()] : []),
    ...pathEnv.split(pathSeparator).filter(Boolean),
    ...commonDirs,
  ];

  const found: Partial<Record<MediaBinaryName, string>> = {};
  const seen = new Set<string>();

  for (const directory of directories) {
    const normalizedDirectory = path.resolve(directory.trim().replace(/^"|"$/g, ""));
    if (seen.has(normalizedDirectory)) {
      continue;
    }
    seen.add(normalizedDirectory);

    for (const name of ["ffmpeg", "ffprobe"] as const) {
      if (found[name]) {
        continue;
      }

      for (const executableName of executableNames(name, platform)) {
        const candidate = path.join(normalizedDirectory, executableName);
        if (await isExecutableFile(candidate, platform)) {
          found[name] = await canonicalPath(candidate);
          break;
        }
      }
    }

    if (found.ffmpeg && found.ffprobe) {
      return {
        ffmpeg: found.ffmpeg,
        ffprobe: found.ffprobe,
      };
    }
  }

  return null;
}

export async function resolveMediaBinaries(
  required: MediaBinaryName[] = ["ffmpeg", "ffprobe"],
  options: BinaryResolveOptions = {},
): Promise<MediaBinaries> {
  const found = await findMediaBinaries(options);
  if (found) {
    return found;
  }

  const install = getInstallCommand(options.platform ?? process.platform);
  const missing = required.join(" / ");
  throw new MediaToolError(
    "FFMPEG_NOT_FOUND",
    `未找到 ${missing}。请先安装 FFmpeg，并确保命令位于 PATH 中；插件不会自动下载。`,
    { install },
  );
}
