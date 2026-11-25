import { spawn } from "node:child_process";
import {
  MediaToolError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "./types.js";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class SpawnCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    if (options.signal?.aborted) {
      throw new MediaToolError("CANCELLED", "任务已取消。");
    }

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const cleanup = (clearForceKill = false) => {
        clearTimeout(timeoutTimer);
        if (clearForceKill && forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        options.signal?.removeEventListener("abort", onAbort);
      };

      const rejectOnce = (error: MediaToolError) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(false);
        reject(error);
      };

      const terminate = () => {
        const isRunning =
          child.exitCode === null && child.signalCode === null;
        if (isRunning) {
          child.kill("SIGTERM");
        }
        forceKillTimer = setTimeout(() => {
          const stillRunning =
            child.exitCode === null && child.signalCode === null;
          if (stillRunning) {
            child.kill("SIGKILL");
          }
        }, 2000);
        forceKillTimer.unref();
      };

      const onAbort = () => {
        terminate();
        rejectOnce(new MediaToolError("CANCELLED", "任务已取消。"));
      };

      const timeoutTimer = setTimeout(() => {
        terminate();
        rejectOnce(
          new MediaToolError(
            "COMMAND_TIMEOUT",
            `命令执行超过 ${options.timeoutMs} 毫秒，已终止。`,
          ),
        );
      }, options.timeoutMs);
      timeoutTimer.unref();

      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
          terminate();
          rejectOnce(
            new MediaToolError(
              "COMMAND_OUTPUT_LIMIT",
              "命令输出超过允许大小，已终止。",
            ),
          );
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr, "utf8") > MAX_CAPTURE_BYTES) {
          terminate();
          rejectOnce(
            new MediaToolError(
              "COMMAND_OUTPUT_LIMIT",
              "命令输出超过允许大小，已终止。",
            ),
          );
        }
      });

      child.once("error", (error) => {
        rejectOnce(
          new MediaToolError(
            "COMMAND_FAILED",
            "无法启动 FFmpeg 命令，请检查可执行文件与权限。",
            { cause: error },
          ),
        );
      });

      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(true);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}
