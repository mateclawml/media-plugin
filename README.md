# MateClaw 音视频插件（开源）

麦灵的音视频能力做成一个**独立的开源插件**：视频抽帧、音频提取、格式转换。

- 用它需要麦灵（或任意 OpenClaw）已经装好
- 它**不附带 FFmpeg 二进制**，调用你机器上自己装的 FFmpeg
- 代码 MIT，随便看、随便改、欢迎提 PR

> **状态：开发中，还没有第一个可装版本。** 会在这里和 Reels 页更新进度。

> 为什么不做进安装包：FFmpeg 的常见发行版是 GPL，随包分发就要承担源码提供义务，还会让「用个视频功能」变成「接受一份开源协议」。拆出来各归各的，用户干净，我们也干净。

---

## 安装

先确认机器上有 FFmpeg：

```bash
ffmpeg -version
```

没有就装：

```bash
# macOS
brew install ffmpeg

# Windows（任选其一）
winget install Gyan.FFmpeg
choco install ffmpeg
```

然后装插件：

```bash
openclaw plugins install mateclaw-media-plugin
```

装完重启麦灵（或 OpenClaw 网关），插件会自动注册成工具。

## 提供了什么

| 工具 | 作用 |
| --- | --- |
| `media_probe` | 读媒体信息：时长、分辨率、编码、码率、音轨 |
| `video_extract_frames` | 抽帧：按时间点或按数量均匀抽，输出 PNG/JPG |
| `audio_extract` | 抽音轨：输出 wav / mp3 / aac / m4a |
| `media_convert` | 转码：指定容器、编码、码率、分辨率 |

设计原则：**只做确定的、可解释的操作**。参数不给就用保守默认值；不猜用户意图，不做「智能一键」。

## 找不到 FFmpeg 会怎样

插件启动时探测 `ffmpeg` / `ffprobe`：

1. 环境变量 `MATECLAW_FFMPEG_PATH`（指向所在目录）
2. 系统 `PATH`
3. 常见安装位置（`/opt/homebrew/bin`、`/usr/local/bin`、`C:\\ffmpeg\\bin`）

找不到时不静默失败，返回一句人话加安装命令。**不会自己去下载 FFmpeg**——那等于我们替用户分发，正是要避免的事。

## 开发

```bash
git clone https://github.com/mateclawml/media-plugin.git
cd media-plugin
npm install
npm test
```

本地试装：

```bash
openclaw plugins install ./ 
```

接口与实现边界见 [SPEC.md](SPEC.md)。

## 许可

代码 MIT，见 [LICENSE](LICENSE)。

FFmpeg 不是本仓库的一部分，按其自身许可使用；本仓库不分发其二进制。商标归属见 [NOTICE.md](NOTICE.md)。
