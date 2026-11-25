import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findMediaBinaries,
  getInstallCommand,
  resolveMediaBinaries,
} from "./ffmpeg.js";
import { MediaToolError } from "./types.js";

const temporaryDirectories: string[] = [];

async function makeBinaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(process.cwd(), ".test-tmp-ffmpeg-"),
  );
  temporaryDirectories.push(directory);
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["ffmpeg", "ffprobe"]) {
    const binaryPath = path.join(directory, `${name}${suffix}`);
    await writeFile(binaryPath, "");
    if (process.platform !== "win32") {
      await chmod(binaryPath, 0o755);
    }
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FFmpeg 定位", () => {
  it("环境变量目录优先于 PATH", async () => {
    const envDirectory = await makeBinaryDirectory();
    const pathDirectory = await makeBinaryDirectory();

    const result = await findMediaBinaries({
      envDir: envDirectory,
      pathEnv: pathDirectory,
      commonDirs: [],
    });
    const suffix = process.platform === "win32" ? ".exe" : "";

    expect(result?.ffmpeg).toBe(
      await realpath(path.join(envDirectory, `ffmpeg${suffix}`)),
    );
    expect(result?.ffprobe).toBe(
      await realpath(path.join(envDirectory, `ffprobe${suffix}`)),
    );
  });

  it("没有候选目录时返回空结果，且不尝试下载", async () => {
    await expect(
      findMediaBinaries({
        platform: "darwin",
        envDir: "",
        pathEnv: "",
        commonDirs: [],
      }),
    ).resolves.toBeNull();
  });

  it("缺失时返回 FFMPEG_NOT_FOUND 与平台安装命令", async () => {
    try {
      await resolveMediaBinaries(["ffmpeg", "ffprobe"], {
        platform: "darwin",
        envDir: "",
        pathEnv: "",
        commonDirs: [],
      });
      throw new Error("预期抛出缺少 FFmpeg 的错误");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).code).toBe("FFMPEG_NOT_FOUND");
      expect((error as MediaToolError).install).toBe("brew install ffmpeg");
    }
  });

  it("为各主要平台提供安装命令", () => {
    expect(getInstallCommand("darwin")).toContain("brew install ffmpeg");
    expect(getInstallCommand("win32")).toContain("winget install");
    expect(getInstallCommand("linux")).toContain("apt install ffmpeg");
  });
});
