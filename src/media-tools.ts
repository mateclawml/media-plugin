import { rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildAudioArgs,
  buildConvertArgs,
  buildFrameArgs,
  buildProbeArgs,
  frameFileName,
  normalizeExtraArgs,
  type AudioFormat,
  type FrameFormat,
} from "./args.js";
import {
  resolveMediaBinaries,
  type BinaryResolveOptions,
} from "./ffmpeg.js";
import {
  assertPathInput,
  prepareOutputDirectory,
  prepareOutputFile,
  resolveInputFile,
  type ResolvedInput,
} from "./paths.js";
import { SpawnCommandRunner } from "./process.js";
import {
  MediaToolError,
  toMediaErrorResult,
  type CommandRunner,
  type MediaBinaries,
  type MediaConfig,
  type MediaErrorResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;
const reservedOutputPaths = new Set<string>();

export interface MediaProbeInput {
  path: string;
}

export interface VideoExtractFramesInput {
  path: string;
  outDir: string;
  mode: "count" | "timestamps";
  count?: number;
  timestamps?: number[];
  format?: FrameFormat;
  quality?: number;
  maxWidth?: number;
}

export interface AudioExtractInput {
  path: string;
  outPath: string;
  format?: AudioFormat;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: 1 | 2;
  overwrite?: boolean;
}

export interface MediaConvertInput {
  path: string;
  outPath: string;
  videoCodec?: string;
  audioCodec?: string;
  crf?: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  fps?: number;
  extraArgs?: string[];
  overwrite?: boolean;
}

export interface MediaStreamInfo {
  type: string;
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}

export interface MediaProbeSuccess {
  ok: true;
  durationSec: number;
  format: string;
  sizeBytes: number;
  streams: MediaStreamInfo[];
}

export interface ExtractedFrame {
  path: string;
  timeSec: number;
}

export interface VideoExtractFramesSuccess {
  ok: true;
  frames: ExtractedFrame[];
  ffmpegArgs: string[];
}

export interface AudioExtractSuccess {
  ok: true;
  outPath: string;
  durationSec: number;
  sizeBytes: number;
}

export interface MediaConvertSuccess {
  ok: true;
  outPath: string;
  ffmpegArgs: string[];
}

interface ProbeJsonStream {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  bit_rate?: unknown;
  duration?: unknown;
}

interface ProbeJsonFormat {
  duration?: unknown;
  format_name?: unknown;
  size?: unknown;
}

interface ProbeJson {
  format?: ProbeJsonFormat;
  streams?: ProbeJsonStream[];
}

interface ProbedMedia {
  durationSec: number;
  format: string;
  sizeBytes: number;
  streams: MediaStreamInfo[];
}

export interface MediaRuntime {
  runner: CommandRunner;
  resolveBinaries: (
    required?: Array<keyof MediaBinaries>,
    options?: BinaryResolveOptions,
  ) => Promise<MediaBinaries>;
}

const defaultRuntime: MediaRuntime = {
  runner: new SpawnCommandRunner(),
  resolveBinaries: resolveMediaBinaries,
};

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(
  value: unknown,
  defaultValue?: number,
): number | undefined {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = finiteNumber(value);
  return parsed !== undefined &&
    Number.isInteger(parsed) &&
    parsed > 0
    ? parsed
    : undefined;
}

function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.includes("/")) {
    const parsed = finiteNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
  }
  const [numerator, denominator] = value.split("/", 2).map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }
  const rate = numerator / denominator;
  return rate > 0 ? rate : undefined;
}

function resolveTimeout(config: MediaConfig | undefined): number {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      `timeoutMs 必须是 ${MIN_TIMEOUT_MS} 至 ${MAX_TIMEOUT_MS} 之间的整数。`,
    );
  }
  return timeoutMs;
}

function normalizeBoolean(
  value: unknown,
  label: string,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new MediaToolError("INVALID_INPUT", `${label}必须是布尔值。`);
  }
  return value;
}

async function runCommand(
  runtime: MediaRuntime,
  binary: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failureCode: "PROBE_FAILED" | "COMMAND_FAILED",
): Promise<string> {
  let result;
  try {
    result = await runtime.runner.run(binary, args, {
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof MediaToolError) {
      throw new MediaToolError(error.code, error.message, {
        cause: error,
        exitCode: error.exitCode,
        ffmpegArgs: args,
        install: error.install,
      });
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const label = failureCode === "PROBE_FAILED" ? "ffprobe" : "FFmpeg";
    throw new MediaToolError(
      failureCode,
      `${label} 执行失败（退出码 ${result.exitCode}）。`,
      {
        ffmpegArgs: args,
        exitCode: result.exitCode,
      },
    );
  }
  return result.stdout;
}

async function probeMedia(
  runtime: MediaRuntime,
  input: ResolvedInput,
  binaries: MediaBinaries,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProbedMedia> {
  const args = buildProbeArgs(input.realPath);
  const stdout = await runCommand(
    runtime,
    binaries.ffprobe,
    args,
    timeoutMs,
    signal,
    "PROBE_FAILED",
  );

  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(stdout) as ProbeJson;
  } catch (error) {
    throw new MediaToolError("PROBE_FAILED", "ffprobe 返回了无法解析的结果。", {
      cause: error,
      ffmpegArgs: args,
    });
  }

  const rawStreams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const streams: MediaStreamInfo[] = rawStreams.map((stream) => {
    const type =
      typeof stream.codec_type === "string" ? stream.codec_type : "unknown";
    const codec =
      typeof stream.codec_name === "string" ? stream.codec_name : "unknown";
    const width = positiveInteger(stream.width);
    const height = positiveInteger(stream.height);
    const fps =
      parseFrameRate(stream.avg_frame_rate) ??
      parseFrameRate(stream.r_frame_rate);
    const sampleRate = positiveInteger(stream.sample_rate);
    const channels = positiveInteger(stream.channels);
    const detectedBitrate = finiteNumber(stream.bit_rate);
    const bitrate =
      detectedBitrate !== undefined && detectedBitrate >= 0
        ? Math.trunc(detectedBitrate)
        : undefined;

    return {
      type,
      codec,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(fps === undefined ? {} : { fps }),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
      ...(bitrate === undefined ? {} : { bitrate }),
    };
  });

  const formatDuration = finiteNumber(parsed.format?.duration);
  const streamDurations = rawStreams
    .map((stream) => finiteNumber(stream.duration))
    .filter((duration): duration is number => duration !== undefined);
  const detectedDuration =
    formatDuration ??
    (streamDurations.length > 0 ? Math.max(...streamDurations) : 0);
  const durationSec = Math.max(0, detectedDuration);
  const format =
    typeof parsed.format?.format_name === "string"
      ? parsed.format.format_name
      : "unknown";
  const formatSize = finiteNumber(parsed.format?.size);

  return {
    durationSec,
    format,
    sizeBytes:
      formatSize !== undefined && formatSize >= 0
        ? Math.trunc(formatSize)
        : input.stats.size,
    streams,
  };
}

function validateMaxWidth(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 16_384
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "maxWidth 必须是 1 至 16384 之间的整数。",
    );
  }
  return value;
}

function validateFrameQuality(
  value: unknown,
  format: FrameFormat,
): number {
  if (format !== "jpg" || value === undefined) {
    return 3;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > 31
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "JPG quality 必须是 2 至 31 之间的整数。",
    );
  }
  return value;
}

function frameTimestamps(
  input: VideoExtractFramesInput,
  durationSec: number,
): number[] {
  if (!(durationSec > 0)) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "无法读取视频时长，不能计算抽帧时间点。",
    );
  }

  if (input.mode === "count") {
    const count = input.count ?? 5;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200
    ) {
      throw new MediaToolError(
        "INVALID_INPUT",
        "count 必须是 1 至 200 之间的整数。",
      );
    }
    return Array.from({ length: count }, (_value, index) =>
      Number((((index + 0.5) * durationSec) / count).toFixed(3)),
    );
  }

  if (input.mode !== "timestamps") {
    throw new MediaToolError(
      "INVALID_INPUT",
      'mode 必须是 "count" 或 "timestamps"。',
    );
  }
  if (
    !Array.isArray(input.timestamps) ||
    input.timestamps.length === 0 ||
    input.timestamps.length > 200
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "timestamps 必须是包含 1 至 200 个数字的数组。",
    );
  }

  return input.timestamps.map((timestamp) => {
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      timestamp >= durationSec
    ) {
      throw new MediaToolError(
        "INVALID_INPUT",
        `时间点 ${String(timestamp)} 必须位于 0（含）到视频时长（不含）之间。`,
      );
    }
    return Number(timestamp.toFixed(3));
  });
}

function validateAudioFormat(value: unknown): AudioFormat {
  if (value === undefined) {
    return "mp3";
  }
  if (value === "wav" || value === "mp3" || value === "aac" || value === "m4a") {
    return value;
  }
  throw new MediaToolError(
    "INVALID_INPUT",
    'format 必须是 "wav"、"mp3"、"aac" 或 "m4a"。',
  );
}

function validateAudioBitrate(value: unknown, format: AudioFormat): number {
  if (format === "wav") {
    return 192;
  }
  const bitrate = value ?? 192;
  if (
    typeof bitrate !== "number" ||
    !Number.isInteger(bitrate) ||
    bitrate < 8 ||
    bitrate > 1024
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "bitrateKbps 必须是 8 至 1024 之间的整数。",
    );
  }
  return bitrate;
}

function validateSampleRate(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 8_000 ||
    value > 192_000
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "sampleRate 必须是 8000 至 192000 之间的整数。",
    );
  }
  return value;
}

function validateChannels(value: unknown): 1 | 2 | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 1 && value !== 2) {
    throw new MediaToolError("INVALID_INPUT", "channels 只能是 1 或 2。");
  }
  return value;
}

function validateConvertNumbers(input: MediaConvertInput): void {
  if (
    input.crf !== undefined &&
    (typeof input.crf !== "number" ||
      !Number.isInteger(input.crf) ||
      input.crf < 0 ||
      input.crf > 63)
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "crf 必须是 0 至 63 之间的整数。",
    );
  }
  if (
    input.bitrateKbps !== undefined &&
    (typeof input.bitrateKbps !== "number" ||
      !Number.isInteger(input.bitrateKbps) ||
      input.bitrateKbps < 8 ||
      input.bitrateKbps > 102_400)
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "bitrateKbps 必须是 8 至 102400 之间的整数。",
    );
  }
  for (const [label, value] of [
    ["width", input.width],
    ["height", input.height],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 2 ||
        value > 16_384)
    ) {
      throw new MediaToolError(
        "INVALID_INPUT",
        `${label} 必须是 2 至 16384 之间的整数。`,
      );
    }
  }
  if (
    input.fps !== undefined &&
    (typeof input.fps !== "number" ||
      !Number.isFinite(input.fps) ||
      input.fps <= 0 ||
      input.fps > 240)
  ) {
    throw new MediaToolError(
      "INVALID_INPUT",
      "fps 必须是大于 0 且不超过 240 的数字。",
    );
  }
}

function reserveOutputPath(value: unknown): {
  absolutePath: string;
  release: () => void;
} {
  const absolutePath = path.resolve(assertPathInput(value, "输出路径"));
  if (reservedOutputPaths.has(absolutePath)) {
    throw new MediaToolError(
      "OUTPUT_EXISTS",
      "该输出路径正在被另一个调用写入；请等待其完成或换一个路径。",
    );
  }

  reservedOutputPaths.add(absolutePath);
  return {
    absolutePath,
    release: () => {
      reservedOutputPaths.delete(absolutePath);
    },
  };
}

export function createMediaHandlers(
  runtimeOverrides: Partial<MediaRuntime> = {},
) {
  const runtime: MediaRuntime = {
    ...defaultRuntime,
    ...runtimeOverrides,
  };

  return {
    async mediaProbe(
      input: MediaProbeInput,
      config?: MediaConfig,
      signal?: AbortSignal,
    ): Promise<MediaProbeSuccess | MediaErrorResult> {
      try {
        const timeoutMs = resolveTimeout(config);
        const resolvedInput = await resolveInputFile(input.path);
        const binaries = await runtime.resolveBinaries();
        const result = await probeMedia(
          runtime,
          resolvedInput,
          binaries,
          timeoutMs,
          signal,
        );
        return {
          ok: true,
          ...result,
        };
      } catch (error) {
        return toMediaErrorResult(error);
      }
    },

    async videoExtractFrames(
      input: VideoExtractFramesInput,
      config?: MediaConfig,
      signal?: AbortSignal,
    ): Promise<VideoExtractFramesSuccess | MediaErrorResult> {
      let outputDirectory: string | undefined;
      try {
        const timeoutMs = resolveTimeout(config);
        const format = input.format ?? "png";
        if (format !== "png" && format !== "jpg") {
          throw new MediaToolError(
            "INVALID_INPUT",
            'format 必须是 "png" 或 "jpg"。',
          );
        }
        const quality = validateFrameQuality(input.quality, format);
        const maxWidth = validateMaxWidth(input.maxWidth);
        const resolvedInput = await resolveInputFile(input.path);
        const binaries = await runtime.resolveBinaries();
        const probed = await probeMedia(
          runtime,
          resolvedInput,
          binaries,
          timeoutMs,
          signal,
        );
        if (!probed.streams.some((stream) => stream.type === "video")) {
          throw new MediaToolError(
            "NO_VIDEO_STREAM",
            "输入文件不包含视频轨道。",
          );
        }

        const timestamps = frameTimestamps(input, probed.durationSec);
        outputDirectory = await prepareOutputDirectory(
          resolvedInput,
          input.outDir,
        );

        const finalArgs = buildFrameArgs(
          resolvedInput.realPath,
          outputDirectory,
          timestamps,
          format,
          quality,
          maxWidth,
        );
        await runCommand(
          runtime,
          binaries.ffmpeg,
          finalArgs,
          timeoutMs,
          signal,
          "COMMAND_FAILED",
        );

        const frames: ExtractedFrame[] = [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const framePath = path.join(
            outputDirectory,
            frameFileName(index, format),
          );
          const frameStats = await stat(framePath);
          if (!frameStats.isFile() || frameStats.size === 0) {
            throw new MediaToolError(
              "COMMAND_FAILED",
              "FFmpeg 未生成完整的抽帧结果。",
              { ffmpegArgs: finalArgs },
            );
          }
          frames.push({
            path: framePath,
            timeSec: timestamps[index],
          });
        }

        return {
          ok: true,
          frames,
          ffmpegArgs: finalArgs,
        };
      } catch (error) {
        if (outputDirectory) {
          await rm(outputDirectory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        return toMediaErrorResult(error);
      }
    },

    async audioExtract(
      input: AudioExtractInput,
      config?: MediaConfig,
      signal?: AbortSignal,
    ): Promise<AudioExtractSuccess | MediaErrorResult> {
      let releaseOutput: (() => void) | undefined;
      try {
        const timeoutMs = resolveTimeout(config);
        const format = validateAudioFormat(input.format);
        const bitrateKbps = validateAudioBitrate(input.bitrateKbps, format);
        const sampleRate = validateSampleRate(input.sampleRate);
        const channels = validateChannels(input.channels);
        const overwrite = normalizeBoolean(input.overwrite, "overwrite");
        const resolvedInput = await resolveInputFile(input.path);
        const binaries = await runtime.resolveBinaries();
        const probed = await probeMedia(
          runtime,
          resolvedInput,
          binaries,
          timeoutMs,
          signal,
        );
        if (!probed.streams.some((stream) => stream.type === "audio")) {
          throw new MediaToolError(
            "NO_AUDIO_STREAM",
            "输入文件不包含音频轨道。",
          );
        }

        const reservation = reserveOutputPath(input.outPath);
        releaseOutput = reservation.release;
        const output = await prepareOutputFile(
          resolvedInput,
          reservation.absolutePath,
          overwrite,
        );
        const args = buildAudioArgs({
          inputPath: resolvedInput.realPath,
          outputPath: output.absolutePath,
          format,
          bitrateKbps,
          sampleRate,
          channels,
          overwrite,
        });
        await runCommand(
          runtime,
          binaries.ffmpeg,
          args,
          timeoutMs,
          signal,
          "COMMAND_FAILED",
        );
        const outputStats = await stat(output.absolutePath);
        if (!outputStats.isFile() || outputStats.size === 0) {
          throw new MediaToolError(
            "COMMAND_FAILED",
            "FFmpeg 未生成有效的音频文件。",
            { ffmpegArgs: args },
          );
        }

        return {
          ok: true,
          outPath: output.absolutePath,
          durationSec: probed.durationSec,
          sizeBytes: outputStats.size,
        };
      } catch (error) {
        return toMediaErrorResult(error);
      } finally {
        releaseOutput?.();
      }
    },

    async mediaConvert(
      input: MediaConvertInput,
      config?: MediaConfig,
      signal?: AbortSignal,
    ): Promise<MediaConvertSuccess | MediaErrorResult> {
      let releaseOutput: (() => void) | undefined;
      try {
        const timeoutMs = resolveTimeout(config);
        const overwrite = normalizeBoolean(input.overwrite, "overwrite");
        validateConvertNumbers(input);
        normalizeExtraArgs(input.extraArgs);

        const hasVisualTransform =
          input.crf !== undefined ||
          input.width !== undefined ||
          input.height !== undefined ||
          input.fps !== undefined;
        if (input.videoCodec === "copy" && hasVisualTransform) {
          throw new MediaToolError(
            "INVALID_INPUT",
            "videoCodec=copy 时不能同时指定 crf、width、height 或 fps。",
          );
        }

        const resolvedInput = await resolveInputFile(input.path);
        const binaries = await runtime.resolveBinaries();
        const probed = await probeMedia(
          runtime,
          resolvedInput,
          binaries,
          timeoutMs,
          signal,
        );
        const hasVideo = probed.streams.some(
          (stream) => stream.type === "video",
        );
        const hasAudio = probed.streams.some(
          (stream) => stream.type === "audio",
        );
        if (!hasVideo && !hasAudio) {
          throw new MediaToolError(
            "INVALID_INPUT",
            "输入文件不包含可转换的音视频轨道。",
          );
        }
        if (input.videoCodec !== undefined && !hasVideo) {
          throw new MediaToolError(
            "NO_VIDEO_STREAM",
            "输入文件不包含视频轨道，不能指定 videoCodec。",
          );
        }
        if (hasVisualTransform && !hasVideo) {
          throw new MediaToolError(
            "NO_VIDEO_STREAM",
            "输入文件不包含视频轨道，不能指定视频转换参数。",
          );
        }
        if (input.audioCodec !== undefined && !hasAudio) {
          throw new MediaToolError(
            "NO_AUDIO_STREAM",
            "输入文件不包含音频轨道，不能指定 audioCodec。",
          );
        }

        const videoWillEncode =
          hasVideo &&
          (Boolean(input.videoCodec && input.videoCodec !== "copy") ||
            (!input.videoCodec &&
              (hasVisualTransform || input.bitrateKbps !== undefined)));
        const audioWillEncode =
          hasAudio &&
          input.audioCodec !== undefined &&
          input.audioCodec !== "copy";
        if (
          input.bitrateKbps !== undefined &&
          !videoWillEncode &&
          !audioWillEncode
        ) {
          throw new MediaToolError(
            "INVALID_INPUT",
            "bitrateKbps 需要配合实际视频或音频编码使用。",
          );
        }

        const reservation = reserveOutputPath(input.outPath);
        releaseOutput = reservation.release;
        const output = await prepareOutputFile(
          resolvedInput,
          reservation.absolutePath,
          overwrite,
        );
        const args = buildConvertArgs({
          inputPath: resolvedInput.realPath,
          outputPath: output.absolutePath,
          hasVideo,
          hasAudio,
          videoCodec: input.videoCodec,
          audioCodec: input.audioCodec,
          crf: input.crf,
          bitrateKbps: input.bitrateKbps,
          width: input.width,
          height: input.height,
          fps: input.fps,
          extraArgs: input.extraArgs,
          overwrite,
        });
        await runCommand(
          runtime,
          binaries.ffmpeg,
          args,
          timeoutMs,
          signal,
          "COMMAND_FAILED",
        );
        const outputStats = await stat(output.absolutePath);
        if (!outputStats.isFile() || outputStats.size === 0) {
          throw new MediaToolError(
            "COMMAND_FAILED",
            "FFmpeg 未生成有效的输出文件。",
            { ffmpegArgs: args },
          );
        }

        return {
          ok: true,
          outPath: output.absolutePath,
          ffmpegArgs: args,
        };
      } catch (error) {
        return toMediaErrorResult(error);
      } finally {
        releaseOutput?.();
      }
    },
  };
}
