import path from "node:path";
import { MediaToolError } from "./types.js";

export type FrameFormat = "png" | "jpg";
export type AudioFormat = "wav" | "mp3" | "aac" | "m4a";

export interface AudioArgsInput {
  inputPath: string;
  outputPath: string;
  format: AudioFormat;
  bitrateKbps: number;
  sampleRate?: number;
  channels?: 1 | 2;
  overwrite: boolean;
}

export interface ConvertArgsInput {
  inputPath: string;
  outputPath: string;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  crf?: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  fps?: number;
  extraArgs?: string[];
  overwrite: boolean;
}

const EXTRA_VALUE_RULES = new Map<string, (value: string) => boolean>([
  [
    "-movflags",
    (value) => /^(?:[+-]?[a-zA-Z0-9_]+)(?:[+-][a-zA-Z0-9_]+)*$/.test(value),
  ],
  [
    "-pix_fmt",
    (value) =>
      new Set([
        "yuv420p",
        "yuv422p",
        "yuv444p",
        "yuv420p10le",
        "yuv422p10le",
        "yuv444p10le",
        "rgb24",
        "rgba",
        "gray",
      ]).has(value),
  ],
  [
    "-profile:v",
    (value) => /^(?:baseline|main|high|high10|high422|high444)$/.test(value),
  ],
  ["-profile", (value) => /^[a-zA-Z0-9._-]+$/.test(value)],
  [
    "-preset",
    (value) =>
      /^(?:ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|placebo)$/.test(
        value,
      ),
  ],
  [
    "-tune",
    (value) =>
      /^(?:film|animation|grain|stillimage|fastdecode|zerolatency)$/.test(
        value,
      ),
  ],
  ["-level", (value) => /^[0-9]+(?:\.[0-9]+)?$/.test(value)],
  ["-max_muxing_queue_size", (value) => /^[1-9][0-9]{0,5}$/.test(value)],
  ["-fps_mode", (value) => /^(?:passthrough|cfr|vfr|auto)$/.test(value)],
]);

const EXTRA_FLAGS = new Set(["-shortest"]);

function validateCodec(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new MediaToolError(
      "INVALID_INPUT",
      `${label}只能包含字母、数字、点、下划线和短横线。`,
    );
  }
  return value;
}

export function normalizeExtraArgs(extraArgs: unknown): string[] {
  if (extraArgs === undefined) {
    return [];
  }
  if (!Array.isArray(extraArgs)) {
    throw new MediaToolError("INVALID_INPUT", "extraArgs 必须是字符串数组。");
  }
  if (extraArgs.length === 0) {
    return [];
  }
  if (extraArgs.length > 32) {
    throw new MediaToolError("INVALID_INPUT", "extraArgs 最多允许 32 项。");
  }

  const normalized: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const option = extraArgs[index];
    if (typeof option !== "string") {
      throw new MediaToolError("INVALID_INPUT", "extraArgs 只能包含字符串。");
    }

    if (EXTRA_FLAGS.has(option)) {
      normalized.push(option);
      continue;
    }

    const rule = EXTRA_VALUE_RULES.get(option);
    if (!rule) {
      throw new MediaToolError(
        "INVALID_INPUT",
        `extraArgs 不允许参数 ${option}。`,
      );
    }

    const value = extraArgs[index + 1];
    if (value === undefined || !rule(value)) {
      throw new MediaToolError(
        "INVALID_INPUT",
        `extraArgs 中 ${option} 的值无效。`,
      );
    }
    normalized.push(option, value);
    index += 1;
  }

  return normalized;
}

export function buildProbeArgs(inputPath: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ];
}

export function frameFileName(index: number, format: FrameFormat): string {
  return `frame-${String(index + 1).padStart(4, "0")}.${format}`;
}

export function buildFrameArgs(
  inputPath: string,
  outputDirectory: string,
  timestamps: number[],
  format: FrameFormat,
  quality: number,
  maxWidth?: number,
): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-i",
    inputPath,
  ];

  const scaleFilter =
    maxWidth === undefined ? undefined : `scale='min(iw,${maxWidth})':-2`;

  timestamps.forEach((timestamp, index) => {
    args.push(
      "-ss",
      timestamp.toFixed(3),
      "-map",
      "0:v:0",
      "-an",
      "-frames:v",
      "1",
    );
    if (format === "png") {
      args.push("-c:v", "png");
    } else {
      args.push("-c:v", "mjpeg", "-q:v", String(quality));
    }
    if (scaleFilter) {
      args.push("-vf", scaleFilter);
    }
    args.push(path.join(outputDirectory, frameFileName(index, format)));
  });

  return args;
}

export function buildAudioArgs(input: AudioArgsInput): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    input.overwrite ? "-y" : "-n",
    "-i",
    input.inputPath,
    "-vn",
  ];

  if (input.format === "wav") {
    args.push("-c:a", "pcm_s16le");
  } else {
    args.push(
      "-c:a",
      input.format === "mp3" ? "libmp3lame" : "aac",
      "-b:a",
      `${input.bitrateKbps}k`,
    );
  }

  if (input.sampleRate !== undefined) {
    args.push("-ar", String(input.sampleRate));
  }
  if (input.channels !== undefined) {
    args.push("-ac", String(input.channels));
  }

  args.push(input.outputPath);
  return args;
}

function buildScaleFilter(
  width: number | undefined,
  height: number | undefined,
): string | undefined {
  if (width !== undefined && height !== undefined) {
    return `scale=${width}:${height}`;
  }
  if (width !== undefined) {
    return `scale=${width}:-2`;
  }
  if (height !== undefined) {
    return `scale=-2:${height}`;
  }
  return undefined;
}

export function buildConvertArgs(input: ConvertArgsInput): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    input.overwrite ? "-y" : "-n",
    "-i",
    input.inputPath,
  ];

  const visualTransform =
    input.crf !== undefined ||
    input.width !== undefined ||
    input.height !== undefined ||
    input.fps !== undefined ||
    input.bitrateKbps !== undefined;
  const videoWillEncode =
    input.hasVideo &&
    (Boolean(input.videoCodec && input.videoCodec !== "copy") ||
      (!input.videoCodec && visualTransform));

  if (input.hasVideo) {
    const videoCodec =
      input.videoCodec ??
      (visualTransform ? "libx264" : "copy");
    args.push("-c:v", validateCodec(videoCodec, "videoCodec"));

    const scaleFilter = buildScaleFilter(input.width, input.height);
    if (scaleFilter) {
      args.push("-vf", scaleFilter);
    }
    if (input.crf !== undefined) {
      args.push("-crf", String(input.crf));
    }
    if (input.fps !== undefined) {
      args.push("-r", String(input.fps));
    }
  }

  if (input.hasAudio) {
    args.push(
      "-c:a",
      validateCodec(input.audioCodec ?? "copy", "audioCodec"),
    );
  }

  if (input.bitrateKbps !== undefined) {
    if (videoWillEncode) {
      args.push("-b:v", `${input.bitrateKbps}k`);
    } else if (input.hasAudio && input.audioCodec !== "copy") {
      args.push("-b:a", `${input.bitrateKbps}k`);
    }
  }

  args.push(...normalizeExtraArgs(input.extraArgs));
  args.push(input.outputPath);
  return args;
}
