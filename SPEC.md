# SPEC —— 音视频插件接口设计

状态：草案（2026-11-25）｜实现待 Codex 落地

## 一、范围

只做四件事，别扩：

1. `media_probe`：读媒体信息，不写文件
2. `video_extract_frames`：视频 → 图片序列
3. `audio_extract`：视频/音频 → 单独音轨
4. `media_convert`：通用转码

不做：字幕、滤镜链拼接、直播推流、AI 分析（那是别的插件的事）。

## 二、FFmpeg 定位

顺序：

1. 环境变量 `MATECLAW_FFMPEG_PATH`（目录，内含 ffmpeg/ffprobe）
2. `PATH`
3. 平台常见目录

找不到 → 返回结构化错误 `{ ok:false, code:"FFMPEG_NOT_FOUND", install:"<按平台给出的命令>" }`。禁止自动下载。

## 三、工具签名

### media_probe

```
input:  { path: string }
output: { ok, durationSec, format, sizeBytes, streams: [{ type, codec, width?, height?, fps?, sampleRate?, channels?, bitrate? }] }
```

实现：`ffprobe -v error -print_format json -show_format -show_streams <path>`

### video_extract_frames

```
input:  { path: string, outDir: string, mode: "count" | "timestamps", count?: number, timestamps?: number[], format?: "png"|"jpg", quality?: number, maxWidth?: number }
output: { ok, frames: [{ path, timeSec }], ffmpegArgs }
```

- `mode:"count"`：均匀抽，默认 5 帧，最少 1、最多 200
- `mode:"timestamps"`：按给定秒数抽，最多 200 个
- 默认 png；jpg 时 `-q:v` 默认 3
- 输出文件名固定可预期：`frame-0001.png` 递增
- 必须回传实际执行的参数，便于用户自查

### audio_extract

```
input:  { path: string, outPath: string, format?: "wav"|"mp3"|"aac"|"m4a", bitrateKbps?: number, sampleRate?: number, channels?: 1|2 }
output: { ok, outPath, durationSec?, sizeBytes? }
```

- 默认 mp3 / 192 kbps / 保持原采样率与声道
- wav 时忽略码率参数（无损 pcm_s16le）

### media_convert

```
input:  { path: string, outPath: string, videoCodec?: string, audioCodec?: string, crf?: number, bitrateKbps?: number, width?: number, height?: number, fps?: number, extraArgs?: string[] }
output: { ok, outPath, ffmpegArgs }
```

- 不传视频参数就 `-c:v copy`；不传音频参数就 `-c:a copy`
- `extraArgs` 只允许白名单内的安全参数，其余拒绝（防止用户被诱导注入任意参数）
- 输出文件已存在时默认拒绝覆盖，除非传 `overwrite:true`

## 四、安全

- 所有路径做存在性与可写性检查；输出目录自动创建但限于用户目录与本卷
- 不接收 URL 作为输入（避免变成下载器）
- 子进程用参数数组调用，不走 shell 字符串拼接
- 单次执行超时默认 10 分钟，可配置上限 30 分钟
- 日志只记命令与退出码，不记文件内容

## 五、验收

- 未装 FFmpeg：四个工具都返回可读错误 + 安装命令，不崩溃
- 装了 FFmpeg：对一段 10 秒测试视频，四个工具全部成功，产物可播放/可打开
- 中文路径与带空格路径正常
- 长文件名与超长路径不炸
- 并发两次调用不互相覆盖（输出目录冲突时拒绝，不静默改名）

## 六、与麦灵的关系

麦灵安装包不含本插件，也不含 FFmpeg。用户装完麦灵后自行安装本插件；插件对麦灵是不可见依赖，卸载后麦灵其他功能照常。

麦灵侧代码**不改**：现有功能若依赖内置 ffmpeg，改为「检测到插件则用，检测不到则提示安装」。此项由 Codex 在插件落地后单独排期。
