import { describe, expect, it } from "vitest";
import { assertPathInput } from "./paths.js";
import { MediaToolError } from "./types.js";

describe("路径输入校验", () => {
  it("拒绝 HTTP、文件 URI 与其他 scheme", () => {
    for (const value of [
      "https://example.com/media.mp4",
      "file:///tmp/media.mp4",
      "rtmp://example.com/live",
    ]) {
      try {
        assertPathInput(value, "输入路径");
        throw new Error("预期拒绝 URL");
      } catch (error) {
        expect(error).toBeInstanceOf(MediaToolError);
        expect((error as MediaToolError).code).toBe("URL_NOT_SUPPORTED");
      }
    }
  });

  it("接受 Windows 盘符绝对路径与相对路径", () => {
    expect(assertPathInput("C:\\媒体\\视频.mp4", "输入路径")).toBe(
      "C:\\媒体\\视频.mp4",
    );
    expect(assertPathInput("D:相对目录\\视频.mp4", "输入路径")).toBe(
      "D:相对目录\\视频.mp4",
    );
  });

  it("拒绝空路径与空字符", () => {
    expect(() => assertPathInput(" ", "输入路径")).toThrow(MediaToolError);
    expect(() => assertPathInput("媒体\0.mp4", "输入路径")).toThrow(
      MediaToolError,
    );
  });
});
