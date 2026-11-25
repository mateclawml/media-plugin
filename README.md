# MateClaw 音视频插件（开源）

麦灵与 OpenClaw 的独立音视频工具插件，提供媒体探测、视频抽帧、音频提取和通用转码。

- 需要 OpenClaw 2026.11.9 或更高版本
- 需要用户自行安装 `ffmpeg` 与 `ffprobe`
- 仓库不附带、不下载、不分发 FFmpeg 二进制
- 代码使用 MIT 许可

> **当前状态：0.1.0。** 四类工具已实现，34 项单元测试与真实 FFmpeg 冒烟测试均通过。**尚未发布到 npm**，暂时按下面的「从源码安装」使用。

> 为什么不做进安装包：FFmpeg 的常见发行版是 GPL，随包分发会增加许可义务。本插件只通过参数数组调用用户已安装的独立进程。

---

## 安装

先确认机器上有 FFmpeg：

```bash
ffmpeg -version
```

没有就按平台安装：

```bash
# macOS
brew install ffmpeg

# Windows（任选其一）
winget install Gyan.FFmpeg
choco install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg
```

然后从源码安装（npm 包尚未发布，发布后这里会改为一行命令）：

```bash
git clone https://github.com/mateclawml/media-plugin.git
cd media-plugin
npm install
npm run build
openclaw plugins install ./
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

工具执行时按以下顺序探测 `ffmpeg` 与 `ffprobe`：

1. 环境变量 `MATECLAW_FFMPEG_PATH`（指向所在目录）
2. 系统 `PATH`
3. 平台常见安装位置（例如 `/opt/homebrew/bin`、`/usr/local/bin`、`C:\ffmpeg\bin`）

找不到时不会静默失败，而是返回结构化错误：

```json
{
  "ok": false,
  "code": "FFMPEG_NOT_FOUND",
  "message": "未找到 FFmpeg 或 ffprobe。请先安装 FFmpeg，并确保两个命令都在 PATH 中；插件不会自动下载。",
  "install": "brew install ffmpeg"
}
```

`install` 会随当前平台变化。插件不会自动下载 FFmpeg。

## 工具参数

### `media_probe`

```json
{ "path": "/绝对路径/媒体文件.mp4" }
```

只读媒体信息，不写文件。

### `video_extract_frames`

```json
{
  "path": "/绝对路径/视频.mp4",
  "outDir": "/绝对路径/新目录",
  "mode": "count",
  "count": 5,
  "format": "png"
}
```

按数量均匀抽帧，或把 `mode` 设为 `timestamps` 并传入 `timestamps`。输出目录必须尚不存在，文件名固定为 `frame-0001.png` 递增。JPG 支持 `quality`，两种模式都支持 `maxWidth`。

### `audio_extract`

```json
{
  "path": "/绝对路径/视频.mp4",
  "outPath": "/绝对路径/音频.mp3"
}
```

默认输出 MP3、192 kbps，并保持原采样率与声道。WAV 使用 `pcm_s16le`，忽略码率参数。已有输出默认拒绝，明确传入 `"overwrite": true` 才允许覆盖。

### `media_convert`

```json
{
  "path": "/绝对路径/输入.mp4",
  "outPath": "/绝对路径/输出.mkv"
}
```

视频与音频默认都使用 `copy`。指定编码、CRF、尺寸、帧率或码率后才重新编码对应轨道。已有输出默认拒绝，明确传入 `"overwrite": true` 才允许覆盖。

`extraArgs` 只接受白名单内的 FFmpeg 参数，例如 `-movflags faststart`、`-pix_fmt yuv420p`、`-preset medium`。未知参数、输入切换、过滤器链、覆盖开关等都会返回错误。

## 安全边界

- 不接收 URL；路径字段出现 URI scheme 会返回错误
- 子进程始终用可执行文件与参数数组启动，`shell` 固定为 `false`
- 输入必须是可读普通文件
- 输出位置必须在用户主目录内，或与输入文件位于同一卷
- 输出已存在时默认拒绝覆盖
- 目标目录冲突时拒绝，不发散文件名
- 同一输出路径的并发写调用会拒绝后到者，不互相覆盖
- FFmpeg 与 ffprobe 单次执行默认超时 10 分钟，最大 30 分钟
- 插件日志不记录媒体文件内容

## 开发

```bash
git clone https://github.com/mateclawml/media-plugin.git
cd media-plugin
npm install
npm test
npm run build
npm run smoke
```

接口与实现边界见 [SPEC.md](SPEC.md)。

实现补充与构建测试记录见 [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md)。

## 许可

代码 MIT，见 [LICENSE](LICENSE)。

FFmpeg 不是本仓库的一部分，按其自身许可使用；本仓库不分发其二进制。商标归属见 [NOTICE.md](NOTICE.md)。
