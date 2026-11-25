import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createMediaHandlers } from "../dist/media-tools.js";
import {
  findMediaBinaries,
  getInstallCommand,
} from "../dist/ffmpeg.js";
import { SpawnCommandRunner } from "../dist/process.js";

function ensureSuccess(result, label) {
  if (!result?.ok) {
    throw new Error(`${label} 未通过：${JSON.stringify(result)}`);
  }
  return result;
}

async function main() {
  const binaries = await findMediaBinaries();
  if (!binaries) {
    const error = {
      ok: false,
      code: "FFMPEG_NOT_FOUND",
      message:
        "未找到 FFmpeg 或 ffprobe。请先安装 FFmpeg，并确保两个命令都在 PATH 中；插件不会自动下载。",
      install: getInstallCommand(),
    };
    console.error(JSON.stringify(error, null, 2));
    process.exitCode = 2;
    return;
  }

  const workDirectory = await mkdtemp(
    path.join(process.cwd(), ".smoke-work-"),
  );
  const runner = new SpawnCommandRunner();
  const config = { timeoutMs: 60_000 };

  try {
    const samplePath = path.join(workDirectory, "测试 素材.mp4");
    const fixture = await runner.run(
      binaries.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "10",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        samplePath,
      ],
      { timeoutMs: 60_000 },
    );
    if (fixture.exitCode !== 0) {
      throw new Error(`测试素材生成失败，退出码 ${fixture.exitCode}`);
    }

    const handlers = createMediaHandlers();
    const probe = ensureSuccess(
      await handlers.mediaProbe({ path: samplePath }, config),
      "media_probe",
    );
    const frames = ensureSuccess(
      await handlers.videoExtractFrames(
        {
          path: samplePath,
          outDir: path.join(workDirectory, "抽帧 输出"),
          mode: "count",
          count: 2,
          format: "png",
          maxWidth: 160,
        },
        config,
      ),
      "video_extract_frames",
    );
    const timestampFrames = ensureSuccess(
      await handlers.videoExtractFrames(
        {
          path: samplePath,
          outDir: path.join(workDirectory, "时间点 输出"),
          mode: "timestamps",
          timestamps: [0.25, 1.5],
          format: "jpg",
          quality: 4,
        },
        config,
      ),
      "video_extract_frames（时间点）",
    );
    const audio = ensureSuccess(
      await handlers.audioExtract(
        {
          path: samplePath,
          outPath: path.join(workDirectory, "音轨 输出.wav"),
          format: "wav",
        },
        config,
      ),
      "audio_extract",
    );
    const converted = ensureSuccess(
      await handlers.mediaConvert(
        {
          path: samplePath,
          outPath: path.join(
            workDirectory,
            `${"长文件名 ".repeat(10)}转码 输出.mkv`,
          ),
        },
        config,
      ),
      "media_convert",
    );
    const audioProbe = ensureSuccess(
      await handlers.mediaProbe({ path: audio.outPath }, config),
      "audio_extract 产物回读",
    );
    const convertedProbe = ensureSuccess(
      await handlers.mediaProbe({ path: converted.outPath }, config),
      "media_convert 产物回读",
    );
    for (const frame of [...frames.frames, ...timestampFrames.frames]) {
      const frameProbe = ensureSuccess(
        await handlers.mediaProbe({ path: frame.path }, config),
        "video_extract_frames 产物回读",
      );
      if (!frameProbe.streams.some((stream) => stream.type === "video")) {
        throw new Error(`抽帧产物无法回读：${frame.path}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          ffmpeg: binaries.ffmpeg,
          ffprobe: binaries.ffprobe,
          probe: {
            durationSec: probe.durationSec,
            format: probe.format,
            streams: probe.streams.length,
          },
          frames: frames.frames.length,
          timestampFrames: timestampFrames.frames.length,
          audioBytes: audio.sizeBytes,
          audioDurationSec: audioProbe.durationSec,
          converted: converted.outPath,
          convertedStreams: convertedProbe.streams.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: "SMOKE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
