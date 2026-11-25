import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  createMediaHandlers,
  type AudioExtractInput,
  type MediaConvertInput,
  type MediaProbeInput,
  type VideoExtractFramesInput,
} from "./media-tools.js";

const configSchema = Type.Object(
  {
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: 1_800_000,
        default: 600_000,
        description:
          "单次 FFmpeg 或 ffprobe 执行的超时毫秒数，默认 10 分钟，最大 30 分钟。",
      }),
    ),
  },
  { additionalProperties: false },
);

const streamSchema = Type.Object(
  {
    type: Type.String({ description: "轨道类型，例如 video 或 audio。" }),
    codec: Type.String({ description: "FFmpeg 编码器名称。" }),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    fps: Type.Optional(Type.Number({ minimum: 0 })),
    sampleRate: Type.Optional(Type.Integer({ minimum: 1 })),
    channels: Type.Optional(Type.Integer({ minimum: 1 })),
    bitrate: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const errorSchema = Type.Object(
  {
    ok: Type.Literal(false),
    code: Type.String({ description: "稳定的结构化错误代码。" }),
    message: Type.String({ description: "可读的中文错误说明。" }),
    install: Type.Optional(
      Type.String({ description: "当前平台的 FFmpeg 安装命令。" }),
    ),
    ffmpegArgs: Type.Optional(
      Type.Array(Type.String(), {
        description: "失败时实际执行的子进程参数。",
      }),
    ),
    exitCode: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

const probeSuccessSchema = Type.Object(
  {
    ok: Type.Literal(true),
    durationSec: Type.Number({ minimum: 0 }),
    format: Type.String(),
    sizeBytes: Type.Integer({ minimum: 0 }),
    streams: Type.Array(streamSchema),
  },
  { additionalProperties: false },
);

const frameOutputSchema = Type.Object(
  {
    path: Type.String(),
    timeSec: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const framesSuccessSchema = Type.Object(
  {
    ok: Type.Literal(true),
    frames: Type.Array(frameOutputSchema),
    ffmpegArgs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const audioSuccessSchema = Type.Object(
  {
    ok: Type.Literal(true),
    outPath: Type.String(),
    durationSec: Type.Number({ minimum: 0 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const convertSuccessSchema = Type.Object(
  {
    ok: Type.Literal(true),
    outPath: Type.String(),
    ffmpegArgs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const overwriteDescription =
  "输出文件已存在时是否允许覆盖，默认 false。";

const handlers = createMediaHandlers();

export default defineToolPlugin({
  id: "mateclaw-media-plugin",
  name: "MateClaw 音视频",
  description: "使用本机 FFmpeg 探测媒体、抽帧、提取音频与转码。",
  configSchema,
  tools: (tool) => [
    tool({
      name: "media_probe",
      label: "媒体探测",
      description: "读取媒体文件的时长、容器、大小和轨道信息，不写入文件。",
      parameters: Type.Object(
        {
          path: Type.String({
            description: "本机媒体文件路径，不接受 URL。",
          }),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Union([probeSuccessSchema, errorSchema]),
      workspaceAccess: "execute",
      execute: async (
        input: MediaProbeInput,
        config,
        context,
      ) => handlers.mediaProbe(input, config, context.signal),
    }),
    tool({
      name: "video_extract_frames",
      label: "视频抽帧",
      description: "从视频按数量均匀抽帧，或按指定时间点抽帧。",
      parameters: Type.Object(
        {
          path: Type.String({ description: "本机视频文件路径，不接受 URL。" }),
          outDir: Type.String({
            description: "尚不存在的输出目录，工具会自动创建。",
          }),
          mode: Type.Union([Type.Literal("count"), Type.Literal("timestamps")], {
            description: "按数量均匀抽帧，或按给定时间点抽帧。",
          }),
          count: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 200,
              default: 5,
              description: "count 模式下的帧数，默认 5。",
            }),
          ),
          timestamps: Type.Optional(
            Type.Array(Type.Number({ minimum: 0 }), {
              minItems: 1,
              maxItems: 200,
              description: "timestamps 模式下按秒给出的时间点。",
            }),
          ),
          format: Type.Optional(
            Type.Union([Type.Literal("png"), Type.Literal("jpg")], {
              default: "png",
              description: "输出图片格式，默认 PNG。",
            }),
          ),
          quality: Type.Optional(
            Type.Integer({
              minimum: 2,
              maximum: 31,
              default: 3,
              description: "JPG 质量，数值越小质量越高，默认 3。",
            }),
          ),
          maxWidth: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 16_384,
              description: "输出图片的最大宽度，保持比例。",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Union([framesSuccessSchema, errorSchema]),
      workspaceAccess: "execute",
      execute: async (
        input: VideoExtractFramesInput,
        config,
        context,
      ) => handlers.videoExtractFrames(input, config, context.signal),
    }),
    tool({
      name: "audio_extract",
      label: "提取音频",
      description: "从视频或音频文件提取单独音轨。",
      parameters: Type.Object(
        {
          path: Type.String({ description: "本机输入文件路径，不接受 URL。" }),
          outPath: Type.String({ description: "输出音频文件路径。" }),
          format: Type.Optional(
            Type.Union(
              [
                Type.Literal("wav"),
                Type.Literal("mp3"),
                Type.Literal("aac"),
                Type.Literal("m4a"),
              ],
              {
                default: "mp3",
                description: "输出格式，默认 MP3。",
              },
            ),
          ),
          bitrateKbps: Type.Optional(
            Type.Integer({
              minimum: 8,
              maximum: 1024,
              description: "有损格式码率；默认 192 kbps，WAV 会忽略。",
            }),
          ),
          sampleRate: Type.Optional(
            Type.Integer({
              minimum: 8_000,
              maximum: 192_000,
              description: "输出采样率；省略时保持原采样率。",
            }),
          ),
          channels: Type.Optional(
            Type.Union([Type.Literal(1), Type.Literal(2)], {
              description: "输出声道数；省略时保持原声道。",
            }),
          ),
          overwrite: Type.Optional(
            Type.Boolean({ description: overwriteDescription }),
          ),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Union([audioSuccessSchema, errorSchema]),
      workspaceAccess: "execute",
      execute: async (
        input: AudioExtractInput,
        config,
        context,
      ) => handlers.audioExtract(input, config, context.signal),
    }),
    tool({
      name: "media_convert",
      label: "媒体转码",
      description: "按指定编码、码率、尺寸或帧率转码音视频文件。",
      parameters: Type.Object(
        {
          path: Type.String({ description: "本机输入文件路径，不接受 URL。" }),
          outPath: Type.String({ description: "输出文件路径。" }),
          videoCodec: Type.Optional(
            Type.String({
              description: "视频编码器；省略且无视频转换参数时使用 copy。",
            }),
          ),
          audioCodec: Type.Optional(
            Type.String({
              description: "音频编码器；省略时使用 copy。",
            }),
          ),
          crf: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: 63,
              description: "视频 CRF；指定后默认使用 libx264 编码。",
            }),
          ),
          bitrateKbps: Type.Optional(
            Type.Integer({
              minimum: 8,
              maximum: 102_400,
              description: "视频或纯音频编码码率。",
            }),
          ),
          width: Type.Optional(
            Type.Integer({
              minimum: 2,
              maximum: 16_384,
              description: "视频输出宽度。",
            }),
          ),
          height: Type.Optional(
            Type.Integer({
              minimum: 2,
              maximum: 16_384,
              description: "视频输出高度。",
            }),
          ),
          fps: Type.Optional(
            Type.Number({
              exclusiveMinimum: 0,
              maximum: 240,
              description: "视频输出帧率。",
            }),
          ),
          extraArgs: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: 32,
              description: "白名单内的额外 FFmpeg 参数键值对。",
            }),
          ),
          overwrite: Type.Optional(
            Type.Boolean({ description: overwriteDescription }),
          ),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Union([convertSuccessSchema, errorSchema]),
      workspaceAccess: "execute",
      execute: async (
        input: MediaConvertInput,
        config,
        context,
      ) => handlers.mediaConvert(input, config, context.signal),
    }),
  ],
});
