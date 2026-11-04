# 第三方组件

本插件复用下列项目的阅读、检索或教学设计，并保留所用源码及静态资源的许可。

- `dsh-ai-library@0.3.39` — MIT — https://github.com/Instant-KING/dsh-ai-library.git

- `@ggboy123/dsh-paper-reader@1.6.1` — MIT — git+https://github.com/GGboya/dsh-paper-reader.git

- `@a9i5k4/dsh-literature@0.3.6` — MIT — git+https://github.com/Aik358/dsh-literature.git

- `dsh-study-coach@0.1.0` — MIT — git+https://github.com/Ame-Choo/dsh-study-coach.git

- `dsh-learning-mode@0.1.1` — MIT — git+https://github.com/CHplus0/dsh-learning-mode.git

- `dsh-obsidian-board@0.2.5` — MIT — git+https://github.com/2026heshao/dsh-obsidian-board.git

- `@restregular/dsh-memory@0.30.1` — MIT — git+https://github.com/RestRegular/dsh-memory

## 2.0.0 新增依赖

- lucide 1.66.0：ISC。完整许可证见 licenses/。
- @floating-ui/dom 1.8.0：MIT。完整许可证见 licenses/。
- @floating-ui/core 1.8.0：MIT。完整许可证见 licenses/。
- @floating-ui/utils 0.2.12：MIT。完整许可证见 licenses/。
- mammoth 1.13.0：BSD-2-Clause。完整许可证见 licenses/。
- turndown 7.2.4：MIT。完整许可证见 licenses/。
- turndown-plugin-gfm 1.0.2：MIT。完整许可证见 licenses/。
- sanitize-html 2.18.1：MIT。完整许可证见 licenses/。
- linkedom 0.18.15：ISC。完整许可证见 licenses/。

## 2.1.0 新增组件

- ProseMirror 及 Markdown 解析依赖打包在本地编辑器中。各组件的版本见 `package-lock.json`，许可证见 `licenses/`。
- 本机的 OpenAI Whisper 与 FFmpeg 由系统提供。Whisper small 模型权重由官方地址单独获取并校验 SHA-256，安装包不含模型权重。
