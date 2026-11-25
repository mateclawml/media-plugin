export type MediaErrorCode =
  | "FFMPEG_NOT_FOUND"
  | "INVALID_INPUT"
  | "URL_NOT_SUPPORTED"
  | "INPUT_NOT_FOUND"
  | "INPUT_NOT_FILE"
  | "INPUT_NOT_READABLE"
  | "OUTPUT_EXISTS"
  | "OUTPUT_NOT_ALLOWED"
  | "OUTPUT_NOT_WRITABLE"
  | "NO_VIDEO_STREAM"
  | "NO_AUDIO_STREAM"
  | "PROBE_FAILED"
  | "COMMAND_FAILED"
  | "COMMAND_TIMEOUT"
  | "COMMAND_OUTPUT_LIMIT"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface MediaErrorResult {
  ok: false;
  code: MediaErrorCode;
  message: string;
  install?: string;
  ffmpegArgs?: string[];
  exitCode?: number;
}

export interface MediaConfig {
  timeoutMs?: number;
}

export interface MediaBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export type MediaBinaryName = keyof MediaBinaries;

export interface CommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

interface MediaToolErrorDetails {
  install?: string;
  ffmpegArgs?: string[];
  exitCode?: number;
  cause?: unknown;
}

export class MediaToolError extends Error {
  readonly code: MediaErrorCode;
  readonly install?: string;
  readonly ffmpegArgs?: string[];
  readonly exitCode?: number;

  constructor(
    code: MediaErrorCode,
    message: string,
    details: MediaToolErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "MediaToolError";
    this.code = code;
    this.install = details.install;
    this.ffmpegArgs = details.ffmpegArgs;
    this.exitCode = details.exitCode;
  }
}

export function toMediaErrorResult(error: unknown): MediaErrorResult {
  if (error instanceof MediaToolError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.install === undefined ? {} : { install: error.install }),
      ...(error.ffmpegArgs === undefined
        ? {}
        : { ffmpegArgs: error.ffmpegArgs }),
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    };
  }

  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "This operation was aborted")
  ) {
    return {
      ok: false,
      code: "CANCELLED",
      message: "任务已取消。",
    };
  }

  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: "工具执行失败，请检查输入与运行环境。",
  };
}
