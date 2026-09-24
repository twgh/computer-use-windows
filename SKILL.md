---
name: computer-use-windows
version: 0.1.1
description: 顶级 Windows 电脑使用 skill，内置独立 runtime，可自举运行，适配任意支持 MCP 的 agent 客户端，不依赖私有原生模块或提取的应用资产。
tags:
  - skill
  - windows
  - computer-use
  - automation
  - mcp
---

# Windows 电脑使用 Skill 0.1.1

当任务需要一套自带独立 runtime 与 MCP server 的便携式 Windows 电脑使用能力时，使用本 skill。

## 本 skill 做什么

- 使用安装目录下自带的 `computer-use-windows` 项目
- 构建独立 MCP server
- 首次启动时让 server 自动自举 Python runtime
- 不依赖任何 agent 客户端的本机二进制、`.node` 模块或提取的应用资产
- 明确仅支持 Windows，因为底层桌面控制后端是 Windows 专属实现
- 上报每块显示器的型号、分辨率、缩放比例及相对主屏的方位——当用户描述某块屏时（"125% 的那块屏"、"右边的屏"），按这些属性识别，因为我们内部的显示器编号可能与 Windows 设置里显示的编号不一致

## 自带项目路径

自带项目位于 `./project`（相对 skill 安装目录，例如 `~/.agents/skills/computer-use-windows/project`）。下文所有路径均相对 skill 根目录。

## 构建

始终从自带项目构建：

```bash
cd ./project
npm install
npm run build
```

## 运行

```bash
cd ./project
node dist/cli.js
```

首次实际运行会自动创建 `./project/.runtime/venv` 并安装公开的 Python 依赖。

## 使用守则

- 仅将本机视为可信本地环境。
- 不要让用户去任何 agent 客户端的本地安装里寻找二进制或隐藏资产。
- 严禁在 skill 或项目目录内创建临时文件（截图、解码图片、JSON dump、测试输出、日志）——一律写入系统临时目录（Windows：`%TEMP%`，即 `C:\Users\<用户>\AppData\Local\Temp`；Unix：`$TMPDIR`）。`project/.runtime/` 下只允许存在自举 venv 及其锁/配置数据。任务结束后清理自己产生的临时文件。
- 明确说明本 runtime 是独立的、只使用公开依赖。
- 说明当前 runtime 上报 `screenshotFiltering: none`，动作门控由 MCP 层处理。
