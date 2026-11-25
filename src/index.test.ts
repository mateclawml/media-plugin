import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";

describe("插件元数据", () => {
  it("声明四个稳定工具名", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.tools.map((tool) => tool.name)).toEqual([
      "media_probe",
      "video_extract_frames",
      "audio_extract",
      "media_convert",
    ]);
  });

  it("为有文件输出的工具声明可选 overwrite 参数", () => {
    const metadata = getToolPluginMetadata(entry);
    const audio = metadata?.tools.find((tool) => tool.name === "audio_extract");
    const convert = metadata?.tools.find(
      (tool) => tool.name === "media_convert",
    );

    expect(audio?.parameters.properties.overwrite).toBeDefined();
    expect(convert?.parameters.properties.overwrite).toBeDefined();
  });
});
