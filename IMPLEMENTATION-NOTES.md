# 实现说明

## 接口补充

`SPEC.md` 没有修改。硬性要求 4 规定“输出路径已存在默认拒绝覆盖，除非 `overwrite=true`”，但 `audio_extract` 与 `media_convert` 的签名草案未列出该字段。为同时满足硬性要求与不修改 `SPEC.md`，实现中为这两个工具增加了可选参数：

- `audio_extract.overwrite?: boolean`
- `media_convert.overwrite?: boolean`

两者默认值均为 `false`。`video_extract_frames` 不增加该字段，目标目录一旦存在就拒绝，保持 SPEC 中“输出目录冲突时拒绝”的要求。

## 其他实现决定

- `ffmpegArgs` 返回实际传给子进程的完整参数数组；抽帧使用一次输入、多路输出的单个 FFmpeg 进程，避免重复打开输入或返回无法对应真实调用的伪参数。
- 抽帧命令显式传入 `-n`；即使输出目录创建后发生异常竞争，FFmpeg 也不会静默覆盖已有帧文件。
- `media_convert.bitrateKbps` 在视频编码时映射为 `-b:v`，仅在纯音频编码时映射为 `-b:a`。既不编码视频也不编码音频时会拒绝，避免参数被静默忽略。
- 超时通过插件配置 `timeoutMs` 设置，默认 600000 毫秒，允许范围 1000 至 1800000 毫秒。
- 输出文件默认使用 FFmpeg 的 `-n`，明确允许覆盖时使用 `-y`；执行前另有存在性、可写性、符号链接与目标位置检查。
- 音频提取与转码会在进程内按绝对输出路径互斥；同一路径的并发调用由后到者返回 `OUTPUT_EXISTS`，不会互相覆盖。
- `ffprobe` 返回的码率会规范为非负整数，确保探测结果始终符合工具的 `outputSchema`。
- URL 校验会识别真正的 URI scheme，同时允许 Windows 盘符绝对路径和盘符相对路径，避免把 `C:\...` 或 `D:...` 误判成 URL。
- 抽帧目录创建完成后再检查最终目录可写性，不只检查其父目录。
- FFmpeg 启动失败、超时或被取消时，结构化错误也会附带本次实际执行的参数数组，便于排查且不泄露文件内容。
- `openclaw.plugin.json` 显式声明 `media` 分类，便于 OpenClaw 目录归类。
- 单元测试额外覆盖 `ffprobe` 失败的参数与退出码、抽帧命令失败后的目录清理，以及工具层拒绝未白名单的 `extraArgs`。

## 构建与测试

验收日期：2026-11-25。执行环境：

- Node.js `v26.7.0`
- npm `11.19.0`
- OpenClaw `2026.11.9`
- macOS 本机 FFmpeg `9.0.1`

### `npm test`

真实输出：

```text

> mateclaw-media-plugin@0.1.0 test
> vitest run --config ./vitest.config.ts


 RUN  v3.2.7 /Users/shaoheng/.openclaw/workspace/projects/mateclaw-github/media-plugin

 ✓ src/paths.test.ts (3 tests) 3ms
 ✓ src/ffmpeg.test.ts (4 tests) 9ms
 ✓ src/process.test.ts (2 tests) 7ms
 ✓ src/media-tools.test.ts (23 tests) 81ms
 ✓ src/index.test.ts (2 tests) 1ms

 Test Files  5 passed (5)
      Tests  34 passed (34)
   Start at  21:07:12
   Duration  538ms (transform 132ms, setup 0ms, collect 489ms, tests 102ms, environment 1ms, prepare 373ms)

```

### `npm run build`

```text

> mateclaw-media-plugin@0.1.0 build
> tsc -p tsconfig.json

```

### 插件校验

`npm run plugin:validate` 真实输出：

```text

> mateclaw-media-plugin@0.1.0 plugin:validate
> npm run build && openclaw plugins validate --entry ./dist/index.js

npm notice run mateclaw-media-plugin@0.1.0 build
npm notice run tsc -p tsconfig.json
Plugin mateclaw-media-plugin is valid.

```

`openclaw plugins build --entry ./dist/index.js --check` 返回：

```text
Plugin metadata is up to date.
```

### 真实 smoke

`npm run smoke` 使用仓库内临时生成的 10 秒测试视频真实调用本机 FFmpeg，覆盖媒体探测、按数量抽帧、按时间点抽帧、WAV 音频提取和默认复制转码；生成的帧、音频和转码文件会再用 `ffprobe` 回读。关键输出：

```text

> mateclaw-media-plugin@0.1.0 smoke
> npm run build && node scripts/smoke.mjs

npm notice run mateclaw-media-plugin@0.1.0 build
npm notice run tsc -p tsconfig.json
{
  "ok": true,
  "ffmpeg": "/opt/homebrew/Cellar/ffmpeg/9.0.1/bin/ffmpeg",
  "ffprobe": "/opt/homebrew/Cellar/ffmpeg/9.0.1/bin/ffprobe",
  "probe": {
    "durationSec": 10,
    "format": "mov,mp4,m4a,3gp,3g2,mj2",
    "streams": 2
  },
  "frames": 2,
  "timestampFrames": 2,
  "audioBytes": 882078,
  "audioDurationSec": 10,
  "converted": "/Users/shaoheng/.openclaw/workspace/projects/mateclaw-github/media-plugin/.smoke-work-fNGnWu/长文件名 长文件名 长文件名 长文件名 长文件名 长文件名 长文件名 长文件名 长文件名 长文件名 转码 输出.mkv",
  "convertedStreams": 2
}
```

该场景同时覆盖中文、空格、长文件名和长路径。

### 打包预检

`npm pack --dry-run --json` 成功，`entryCount` 为 `22`，`bundled` 为空。清单只包含 `dist/`、插件清单、包元数据、中文文档、许可证、NOTICE 和 smoke 脚本，不包含 FFmpeg、测试临时目录或其他外部二进制。
