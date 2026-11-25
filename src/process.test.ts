import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { SpawnCommandRunner } from "./process.js";

describe("子进程启动", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("使用参数数组且明确关闭 shell", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    spawnMock.mockReturnValue(child);

    const runner = new SpawnCommandRunner();
    const promise = runner.run(
      "/tmp/ffmpeg",
      ["-i", "中文 文件.mp4", "-f", "null", "-"],
      { timeoutMs: 1_000 },
    );

    await waitForImmediate();
    child.stdout.write("{}");
    child.exitCode = 0;
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/ffmpeg",
      ["-i", "中文 文件.mp4", "-f", "null", "-"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("超时后先终止，再强制结束仍在运行的子进程", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.killed = true;
      return signal === "SIGTERM";
    });
    spawnMock.mockReturnValue(child);

    const runner = new SpawnCommandRunner();
    const promise = runner.run("/tmp/ffmpeg", ["-version"], {
      timeoutMs: 1_000,
    });
    const rejection = expect(promise).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
