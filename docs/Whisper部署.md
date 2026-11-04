# Whisper 离线转写部署

文献库只在用户主动点击「转写」后调用本机 Whisper。录音和模型文件保留在本机。点击「智能总结」时，插件只把该条录音的完整转写文字发送给当前 Harness 模型，原始音频不会发送。

## 运行条件

需要 Python 3、FFmpeg、FFprobe，以及 Python 包 `openai-whisper`、`torch`、`numpy`。先在终端检查：

```bash
python3 --version
ffmpeg -version
ffprobe -version
python3 -c "import whisper, torch, numpy; print(whisper.__version__)"
```

macOS 可通过 Homebrew 安装 FFmpeg：

```bash
brew install ffmpeg
python3 -m pip install -U openai-whisper torch numpy
```

Python 或 FFmpeg 不在 `PATH` 时，可在启动 Harness 前设置：

```bash
export DSH_LITERATURE_PYTHON=/绝对路径/python3
export DSH_LITERATURE_FFMPEG=/绝对路径/ffmpeg
export DSH_LITERATURE_FFPROBE=/绝对路径/ffprobe
open -a "DeepSeek Harness"
```

## 准备模型

打开任意文献的「笔记」页，录制或打开一段录音，在详情面板选择「准备 Whisper 模型」。插件会下载官方多语 `small` 权重到：

```text
~/.dsh/literature-hub/whisper/small.pt
```

下载完成后会校验 SHA-256：

```text
9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794
```

也可把已校验的 `small.pt` 放到上述目录，或放到 `~/.cache/whisper/small.pt`。模型准备完成后，断网仍可转写。

## 使用与故障处理

录音卡的「查看详情」打开可拖动面板。点击转写后，长录音按 90 秒片段处理，进度、取消和重试都保留已保存的原音。单条录音上限为 4 小时或 200 MB。

状态显示「本机 Whisper 或 FFmpeg 不可用」时，依次检查上述四条命令。状态显示「请先准备 Whisper small 模型」时，在详情面板运行准备操作或检查模型文件路径和校验值。转写失败不会删除音频，仍可播放、重新转写或导出。
