import {
  access,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeExtraArgs } from "./args.js";
import {
  createMediaHandlers,
  type MediaRuntime,
} from "./media-tools.js";
import {
  MediaToolError,
  type CommandResult,
  type CommandRunner,
} from "./types.js";

const temporaryDirectories: string[] = [];

const probeOutput = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 320,
      height: 180,
      avg_frame_rate: "10/1",
      bit_rate: "400000.75",
      duration: "10.0",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "44100",
      channels: 2,
      bit_rate: "128000",
      duration: "10.0",
    },
  ],
  format: {
    duration: "10.0",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    size: "1024",
  },
});

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command.endsWith("ffprobe")) {
      return {
        exitCode: 0,
        stdout: probeOutput,
        stderr: "",
      };
    }

    const frameOutputs = args.filter((arg) =>
      /frame-\d{4}\.(?:png|jpg)$/i.test(arg),
    );
    const outputs =
      frameOutputs.length > 0 ? frameOutputs : [args.at(-1) ?? ""];
    for (const output of outputs) {
      if (output === "") {
        continue;
      }
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "fake-media-output");
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
}

function fakeRuntime(runner: CommandRunner = new FakeRunner()): MediaRuntime {
  return {
    runner,
    resolveBinaries: async () => ({
      ffmpeg: "/fake/bin/ffmpeg",
      ffprobe: "/fake/bin/ffprobe",
    }),
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(process.cwd(), ".test-tmp-media-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function makeFixture(directory: string): Promise<string> {
  const fixture = path.join(directory, "素材 文件.mp4");
  await writeFile(fixture, "fake-input");
  return fixture;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("媒体工具桩测试", () => {
  it("解析 ffprobe JSON 并返回稳定字段", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const handlers = createMediaHandlers(fakeRuntime());

    const result = await handlers.mediaProbe({ path: fixture });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationSec).toBe(10);
      expect(result.sizeBytes).toBe(1024);
      expect(result.streams).toEqual([
        {
          type: "video",
          codec: "h264",
          width: 320,
          height: 180,
          fps: 10,
          bitrate: 400000,
        },
        {
          type: "audio",
          codec: "aac",
          sampleRate: 44100,
          channels: 2,
          bitrate: 128000,
        },
      ]);
    }
  });

  it("按数量生成固定命名且参数使用独立数组项", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));
    const outDir = path.join(directory, "新 输出目录");

    const result = await handlers.videoExtractFrames({
      path: fixture,
      outDir,
      mode: "count",
      count: 3,
      format: "jpg",
      quality: 4,
      maxWidth: 240,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frames.map((frame) => path.basename(frame.path))).toEqual([
        "frame-0001.jpg",
        "frame-0002.jpg",
        "frame-0003.jpg",
      ]);
      expect(result.frames.map((frame) => frame.timeSec)).toEqual([
        1.667, 5, 8.333,
      ]);
      expect(result.ffmpegArgs).toContain(fixture);
      expect(result.ffmpegArgs).toContain("-n");
      expect(result.ffmpegArgs).not.toContain("-y");
      expect(
        result.ffmpegArgs.some((arg) => arg.endsWith("frame-0003.jpg")),
      ).toBe(true);
      expect(result.ffmpegArgs).toContain("-q:v");
    }
  });

  it("时间点模式只打开一次输入并保持顺序", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.videoExtractFrames({
      path: fixture,
      outDir: path.join(directory, "时间点输出"),
      mode: "timestamps",
      timestamps: [0.25, 1.5],
      format: "png",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ffmpegArgs.filter((arg) => arg === fixture)).toHaveLength(
        1,
      );
      expect(result.frames.map((frame) => frame.timeSec)).toEqual([0.25, 1.5]);
    }
  });

  it("WAV 忽略码率并使用 PCM", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));
    const outPath = path.join(directory, "音轨.wav");

    const result = await handlers.audioExtract({
      path: fixture,
      outPath,
      format: "wav",
      bitrateKbps: 999,
    });

    expect(result.ok).toBe(true);
    const ffmpegCall = runner.calls.find((call) =>
      call.command.endsWith("ffmpeg"),
    );
    expect(ffmpegCall?.args).toContain("pcm_s16le");
    expect(ffmpegCall?.args).not.toContain("-b:a");
  });

  it("音频默认输出 MP3 192 kbps 且保持原采样率与声道", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.audioExtract({
      path: fixture,
      outPath: path.join(directory, "默认音轨.mp3"),
    });

    expect(result.ok).toBe(true);
    const ffmpegCall = runner.calls.find((call) =>
      call.command.endsWith("ffmpeg"),
    );
    expect(ffmpegCall?.args).toContain("libmp3lame");
    expect(ffmpegCall?.args).toContain("192k");
    expect(ffmpegCall?.args).not.toContain("-ar");
    expect(ffmpegCall?.args).not.toContain("-ac");
  });

  it("已有输出默认拒绝覆盖", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "已存在.wav");
    await writeFile(outPath, "keep-me");
    const handlers = createMediaHandlers(fakeRuntime());

    const result = await handlers.audioExtract({
      path: fixture,
      outPath,
      format: "wav",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
    expect(await readFile(outPath, "utf8")).toBe("keep-me");
  });

  it("overwrite=true 时允许覆盖并传递 -y", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "允许覆盖.wav");
    await writeFile(outPath, "old");
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.audioExtract({
      path: fixture,
      outPath,
      format: "wav",
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    const ffmpegCall = runner.calls.find((call) =>
      call.command.endsWith("ffmpeg"),
    );
    expect(ffmpegCall?.args).toContain("-y");
    expect(ffmpegCall?.args).not.toContain("-n");
  });

  it("覆盖模式也拒绝把输入文件的硬链接当输出", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const linkedOutput = path.join(directory, "输入硬链接.wav");
    await link(fixture, linkedOutput);
    const handlers = createMediaHandlers(fakeRuntime());

    const result = await handlers.audioExtract({
      path: fixture,
      outPath: linkedOutput,
      format: "wav",
      overwrite: true,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OUTPUT_NOT_ALLOWED",
    });
  });

  it("抽帧目录已存在时拒绝", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outDir = path.join(directory, "已有目录");
    await mkdir(outDir);
    const handlers = createMediaHandlers(fakeRuntime());

    const result = await handlers.videoExtractFrames({
      path: fixture,
      outDir,
      mode: "count",
      count: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
  });

  it("并发写入同一抽帧目录时只允许一个调用成功", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outDir = path.join(directory, "并发输出");
    const handlers = createMediaHandlers(fakeRuntime());

    const results = await Promise.all([
      handlers.videoExtractFrames({
        path: fixture,
        outDir,
        mode: "count",
        count: 1,
      }),
      handlers.videoExtractFrames({
        path: fixture,
        outDir,
        mode: "count",
        count: 1,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
  });

  it("并发写入同一音频输出时只允许一个调用成功", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "并发音频.wav");
    const handlers = createMediaHandlers(fakeRuntime());

    const results = await Promise.all([
      handlers.audioExtract({
        path: fixture,
        outPath,
        format: "wav",
      }),
      handlers.audioExtract({
        path: fixture,
        outPath,
        format: "wav",
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
  });

  it("转码默认复制两条轨道", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));
    const outPath = path.join(directory, "复制输出.mkv");

    const result = await handlers.mediaConvert({
      path: fixture,
      outPath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ffmpegArgs).toContain("-c:v");
      expect(result.ffmpegArgs).toContain("-c:a");
      expect(result.ffmpegArgs.filter((arg) => arg === "copy")).toHaveLength(2);
      expect(result.ffmpegArgs).toContain("-n");
    }
  });

  it("转码已有输出默认拒绝覆盖并保留原文件", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "已有转码输出.mkv");
    await writeFile(outPath, "keep-me");
    const handlers = createMediaHandlers(fakeRuntime());

    const result = await handlers.mediaConvert({
      path: fixture,
      outPath,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
    expect(await readFile(outPath, "utf8")).toBe("keep-me");
  });

  it("转码 overwrite=true 时允许覆盖并传递 -y", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "允许覆盖转码.mkv");
    await writeFile(outPath, "old");
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.mediaConvert({
      path: fixture,
      outPath,
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    const ffmpegCall = runner.calls.find((call) =>
      call.command.endsWith("ffmpeg"),
    );
    expect(ffmpegCall?.args).toContain("-y");
    expect(ffmpegCall?.args).not.toContain("-n");
    expect(await readFile(outPath, "utf8")).toBe("fake-media-output");
  });

  it("媒体工具不会改写输入文件", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const handlers = createMediaHandlers(fakeRuntime());

    const audioResult = await handlers.audioExtract({
      path: fixture,
      outPath: path.join(directory, "独立音轨.mp3"),
    });
    const convertResult = await handlers.mediaConvert({
      path: fixture,
      outPath: path.join(directory, "独立转码.mkv"),
    });

    expect(audioResult.ok).toBe(true);
    expect(convertResult.ok).toBe(true);
    expect(await readFile(fixture, "utf8")).toBe("fake-input");
  });

  it("只给视频码率时自动选择视频重编码", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));
    const outPath = path.join(directory, "码率输出.mp4");

    const result = await handlers.mediaConvert({
      path: fixture,
      outPath,
      bitrateKbps: 2_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ffmpegArgs).toContain("libx264");
      expect(result.ffmpegArgs).toContain("-b:v");
      expect(result.ffmpegArgs).toContain("2000k");
    }
  });

  it("拒绝 URL 与未白名单的 extraArgs", async () => {
    const handlers = createMediaHandlers(fakeRuntime());
    await expect(
      handlers.mediaProbe({ path: "https://example.com/video.mp4" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "URL_NOT_SUPPORTED",
    });

    expect(() =>
      normalizeExtraArgs(["-filter_complex", "movie=bad"]),
    ).toThrow(MediaToolError);
    expect(() => normalizeExtraArgs("-shortest")).toThrow(MediaToolError);
  });

  it("工具层拒绝未白名单的 extraArgs，且不启动子进程", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner = new FakeRunner();
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.mediaConvert({
      path: fixture,
      outPath: path.join(directory, "非法参数输出.mkv"),
      extraArgs: ["-filter_complex", "movie=bad"],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("ffprobe 失败时返回探测错误、参数和退出码", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const runner: CommandRunner = {
      async run(command, args) {
        return {
          exitCode: command.endsWith("ffprobe") ? 2 : 0,
          stdout: "",
          stderr: "模拟探测失败",
        };
      },
    };
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.mediaProbe({ path: fixture });

    expect(result).toMatchObject({
      ok: false,
      code: "PROBE_FAILED",
      exitCode: 2,
    });
    if (!result.ok) {
      expect(result.ffmpegArgs).toContain(fixture);
    }
  });

  it("FFmpeg 抽帧失败时清理本次新建的输出目录", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outDir = path.join(directory, "失败后清理");
    const runner: CommandRunner = {
      async run(command, args) {
        if (command.endsWith("ffprobe")) {
          return {
            exitCode: 0,
            stdout: probeOutput,
            stderr: "",
          };
        }
        await writeFile(args.at(-1) ?? "", "partial-frame");
        return {
          exitCode: 1,
          stdout: "",
          stderr: "模拟抽帧失败",
        };
      },
    };
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.videoExtractFrames({
      path: fixture,
      outDir,
      mode: "count",
      count: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "COMMAND_FAILED",
      exitCode: 1,
    });
    await expect(access(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("子进程超时时返回实际执行的参数数组", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const outPath = path.join(directory, "超时输出.wav");
    const runner: CommandRunner = {
      async run(command, args) {
        if (command.endsWith("ffprobe")) {
          return {
            exitCode: 0,
            stdout: probeOutput,
            stderr: "",
          };
        }
        throw new MediaToolError(
          "COMMAND_TIMEOUT",
          "命令执行超时。",
          { ffmpegArgs: undefined },
        );
      },
    };
    const handlers = createMediaHandlers(fakeRuntime(runner));

    const result = await handlers.audioExtract({
      path: fixture,
      outPath,
      format: "wav",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "COMMAND_TIMEOUT",
    });
    if (!result.ok) {
      expect(result.ffmpegArgs).toContain("-i");
      expect(result.ffmpegArgs).toContain(fixture);
      expect(result.ffmpegArgs).toContain(outPath);
    }
  });

  it("缺少 FFmpeg 时返回安装命令", async () => {
    const handlers = createMediaHandlers({
      runner: new FakeRunner(),
      resolveBinaries: async () => {
        throw new MediaToolError(
          "FFMPEG_NOT_FOUND",
          "未找到 FFmpeg 或 ffprobe。",
          { install: "brew install ffmpeg" },
        );
      },
    });
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);

    await expect(
      handlers.mediaProbe({ path: fixture }),
    ).resolves.toMatchObject({
      ok: false,
      code: "FFMPEG_NOT_FOUND",
      install: "brew install ffmpeg",
    });
  });

  it("四个工具在缺少 FFmpeg 时都返回结构化错误", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = await makeFixture(directory);
    const handlers = createMediaHandlers({
      runner: new FakeRunner(),
      resolveBinaries: async () => {
        throw new MediaToolError(
          "FFMPEG_NOT_FOUND",
          "未找到 FFmpeg 或 ffprobe。",
          { install: "brew install ffmpeg" },
        );
      },
    });

    const results = [
      await handlers.mediaProbe({ path: fixture }),
      await handlers.videoExtractFrames({
        path: fixture,
        outDir: path.join(directory, "缺依赖抽帧"),
        mode: "count",
      }),
      await handlers.audioExtract({
        path: fixture,
        outPath: path.join(directory, "缺依赖音频.wav"),
        format: "wav",
      }),
      await handlers.mediaConvert({
        path: fixture,
        outPath: path.join(directory, "缺依赖转码.mkv"),
      }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        code: "FFMPEG_NOT_FOUND",
        install: "brew install ffmpeg",
      });
    }
  });
});
