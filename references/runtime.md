# Runtime 参考

本文件描述 `computer-use-windows` 的运行机制：目录结构、环境变量、自举链路、Python helper 协议与内部分层。

## 目录结构

```text
SKILL.md                 # 技能入口（agent 先读这个）
README.md                # 面向人的项目说明
references/              # 本目录，按需加载的深度参考
project/
  src/
    cli.ts               # 入口：runServer()，异常写 stderr 后 exit(1)
    server.ts            # 组装 adapter / 工具清单，连接 stdio transport
    session.ts           # 会话状态与锁回调
    computer-use/        # Windows 适配层（executor / gates / pythonBridge / imageSave / 锁 / 应用名过滤）
    vendor/computer-use-mcp/  # 平台无关的 MCP 工具与门控框架
  runtime/
    windows_helper.py    # Python 桌面后端（单文件，命令式）
    requirements.txt     # Python 依赖清单
  package.json           # bin: computer-use-windows -> dist/cli.js
  tsconfig.json
  dist/                  # 构建产物（不打进 zip，需 npm run build 生成）
  .runtime/              # 机器本地状态（不打进 zip，运行时自动生成）
scripts/
  package_skill.py       # 打包脚本
```

### 数据落点

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `project/.runtime/venv/` | 自举出的 Python 虚拟环境 | 首次真正调用工具时创建 |
| `project/.runtime/requirements.sha256` | `requirements.txt` 的 SHA-256 记录 | 与当前文件不一致才重装依赖 |
| `~/.computer-use-windows/computer-use.lock` | 会话锁（JSON：`{sessionId, pid}`） | `O_EXCL` 独占创建；持有进程退出后自动回收 |
| `%TEMP%\computer-use-windows\` | `save_to_disk: true` 保存的截图 | 仅在显式请求落盘时写入，文件名 `<screenshot\|zoom>-<时间戳>-<序号>.jpg` |

除此之外 runtime 不写任何文件：日志只写 stderr，截图默认以 MCP image content 返回。落盘目录刻意不在 skill / project 树内 —— `.runtime/` 只留给自举 venv。

## 环境变量

### 主开关

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_ENABLED` | `0` 关闭，其他值开启 | 开启 | 全局 kill switch；关闭时 `tools/list` 返回空数组 |
| `COMPUTER_USE_COORDINATE_MODE` | `pixels` \| `normalized_0_100` | `pixels` | 坐标语义；同时决定工具描述里呈现的坐标系文案 |
| `COMPUTER_USE_DEBUG` | `1` 开启 | 关闭 | 调试日志到 stderr（前缀 `[computer-use]`） |

`COMPUTER_USE_ENABLED` 与 `COMPUTER_USE_COORDINATE_MODE` 在**模块加载时求值一次**（`project/src/computer-use/gates.ts`），运行期修改无效，必须重启进程。

坐标模式必须与工具描述保持一致：描述文案在构建工具清单时按同一常量固化，两者不一致会导致点击落点错误。

### 子开关

每次调用重新读取（`getChicagoSubGates()`）：

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_CLIPBOARD_PASTE` | `0` 关闭 | 开启 | 多行 `type` 走剪贴板快路径 |
| `COMPUTER_USE_CLIPBOARD_GUARD` | `0` 关闭 | 开启 | `click` tier 前台时暂存并清空用户剪贴板 |
| `COMPUTER_USE_PIXEL_VALIDATION` | `1` 开启 | 关闭 | 点击前 9×9 像素陈旧校验 |
| `COMPUTER_USE_AUTO_TARGET_DISPLAY` | `0` 关闭 | 开启 | 截图前把目标显示器自动切到「已授权应用窗口所在的那块屏」；模型用 `switch_display` 显式指定时以模型为准 |
| `COMPUTER_USE_MOUSE_ANIMATION` | `0` 关闭 | 开启 | 指针缓动：按距离计算 pyautogui tween 时长（2000 px/秒，上限 0.5 秒）。每次点击 / 拖拽 / 移动最多增加约 0.5 秒延迟；关闭则光标瞬移 |
| `COMPUTER_USE_FOCUS_BEFORE_ACTION` | `0` 关闭 | 开启 | 动作前把已授权应用窗口置前（Windows 语义，不隐藏任何窗口）。旧名 `COMPUTER_USE_HIDE_BEFORE_ACTION` 仍被识别：新名未设置时才回退读它 |

### 其他

| 变量 | 作用 |
| --- | --- |
| `CODEX_THREAD_ID` | 会话身份 ID，用于判定"锁是否由自己持有"；缺失时退化为 `pid-<pid>` |
| `PYTHONDONTWRITEBYTECODE` / `PYAUTOGUI_HIDE_SUPPORT_PROMPT` | Python 侧噪声抑制，helper 内 `setdefault` 为 `1` |

## 启动流程

`project/src/cli.ts` → `runServer()`（`project/src/server.ts`）：

1. 构造 host adapter（缓存单例），组装 session 上下文与子门控。
2. 读取坐标模式。
3. 创建 MCP server（`createComputerUseMcpServer`），注册 `tools/call` 处理。
4. 尝试 `listInstalledApps()` 并把可用应用名拼进 `request_access` 的描述文本；失败则退回通用文案。
5. `buildComputerUseTools(...)` 构建工具清单，并注册 `tools/list`：禁用时返回 `{tools: []}`。
6. 连接 `StdioServerTransport`，等待客户端请求。

没有命令行参数解析；唯一的输入通道是 stdio 的 MCP 消息。

## venv 自举

实现在 `project/src/computer-use/pythonBridge.ts`，由 `bootstrapPromise` 单例保护，失败后清空以允许重试。

1. 计算路径：`venv = project/.runtime/venv`，helper 为 `project/runtime/windows_helper.py`。
2. 若 venv 可执行文件不存在：先试 `py -3 -m venv`，失败回退 `python -m venv`。
3. 若 venv 内缺 pip：`python -m ensurepip --upgrade`。
4. 计算 `requirements.txt` 的 SHA-256，与 `.runtime/requirements.sha256` 比对；不一致才执行 `pip install --upgrade pip` + `pip install -r requirements.txt`，随后写入新的 stamp。
5. 每次实际调用都通过 `execFileNoThrow` 起一个短命 Python 进程：`<venv>/Scripts/python.exe windows_helper.py <command> --payload <json>`。

副作用：首次调用延迟较高（建 venv + 装依赖）；后续调用是"一次命令一个进程"。

线上依赖（`project/runtime/requirements.txt`）：`mss>=10.1.0`、`Pillow>=11.3.0`、`pyautogui>=0.9.54`、`psutil>=7.0.0`、`pywin32>=310`。

## Python helper 协议

调用形式：`python windows_helper.py <command> --payload '<json>'`

输出固定为**单行 JSON**：

- 成功：`{"ok": true, "result": <任意类型>}`
- 失败：`{"ok": false, "error": {"code": "...", "message": "..."}}`
- 未知命令：`code: "bad_command"`

### 子命令

| command | payload 键 | `result` |
| --- | --- | --- |
| `check_permissions` | — | `{accessibility: true, screenRecording: true}`（Windows 上恒定） |
| `list_displays` | — | 显示器对象数组，见下 |
| `get_display_size` | `displayId?` | 单个显示器对象 |
| `screenshot` | `displayId?`、`targetWidth?`、`targetHeight?` | `{base64, width, height, displayWidth, displayHeight, displayId, originX, originY, display}` |
| `resolve_prepare_capture` | `preferredDisplayId?`、`autoResolve?`、`allowlistBundleIds?`、`targetWidth?`、`targetHeight?` | 同上 + `hidden: []` + `resolvedDisplayId`（`preferredDisplayId` 为空且 `autoResolve` 为真时，按应用窗口所在屏选显示器） |
| `zoom` | `x`、`y`、`width`、`height`、`targetWidth?`、`targetHeight?` | `{base64, width, height}` |
| `prepare_for_action` | `allowlistBundleIds` | `[]`（**不隐藏窗口**，只把已授权应用置前） |
| `preview_hide_set` | — | `[]` |
| `find_window_displays` | `bundleIds` | `[{bundleId, displayIds: [...]}]` |
| `key` | `keySequence`、`repeat?` | `true` |
| `hold_key` | `keyNames`、`durationMs` | `true` |
| `type` | `text` | `true`（Unicode SendInput） |
| `click` | `x`、`y`、`button`、`count`、`modifiers?`、`animate?` | `true` |
| `drag` | `from?{x,y}`、`to{x,y}`、`animate?` | `true`（拖拽时长不低于 0.2 秒） |
| `move_mouse` | `x`、`y`、`animate?` | `true` |
| `scroll` | `x`、`y`、`deltaX?`、`deltaY?`、`animate?` | `true` |
| `mouse_down` / `mouse_up` | — | `true` |
| `cursor_position` | — | `{x, y}` |
| `frontmost_app` | — | `{bundleId, displayName, elevated, selfElevated}` 或 `null` |
| `app_under_point` | `x`、`y` | 同上 |
| `list_installed_apps` | — | `[{bundleId, displayName, path}]` |
| `list_running_apps` | — | `[{bundleId, displayName}]` |
| `open_app` | `bundleId` | `true` |
| `read_clipboard` | — | 字符串 |
| `write_clipboard` | `text` | `true` |

### 显示器对象

`list_displays` / `get_display_size` 返回：

| 字段 | 含义 |
| --- | --- |
| `id`、`displayId` | 内部编号（等价；`displayId` 为规范化后字段） |
| `width`、`height` | 物理像素宽高 |
| `scaleFactor` | `round(有效DPI / 96, 2)` |
| `originX`、`originY` | 在虚拟桌面中的原点（鼠标绝对坐标会加上它） |
| `isPrimary` | 是否主屏 |
| `name`、`label` | 人类可读名称，形如 `Display N · <型号> · WxH @<缩放>% · <相对主屏方位>`，方位取 `primary` / `above` / `below` / `left of` / `right of` |

注意：`displayId` 来自 `EnumDisplayDevices` 的活动显示序号，可能与 mss 的枚举顺序、以及 Windows 设置界面里显示的编号都不一致。**跨端引用显示器时以型号 / 分辨率 / 缩放 / 方位描述为准。**

## 坐标换算

`scaleCoord`（`project/src/vendor/computer-use-mcp/toolCalls.ts`）是唯一的坐标入口：

- `normalized_0_100`：`x = round(rawX / 100 * display.width) + display.originX`。
- `pixels`：`x = round(rawX * lastScreenshot.displayWidth / lastScreenshot.width) + lastScreenshot.originX`。比例用的是**截图尺寸**（含长边降采样），不是 `1/scaleFactor`；显示器几何取的是**截图时刻**的快照。
- 冷启动（无上一张截图）：退化为 `rawX / display.scaleFactor` 并输出 warn 日志。

消费坐标的工具：五种点击、`scroll`、`left_click_drag`（起点与终点）、`mouse_move`。`zoom` 的 `region` 单独用同一比例换算。

## 分层说明

- `project/src/vendor/computer-use-mcp/` 是**平台无关**的工具 / 门控框架，本身不做任何桌面操作，全部通过注入的 executor 与 host adapter 完成。坐标换算、图像缩放、像素比对、按键黑名单都在这一层。
- `project/src/computer-use/` 是 **Windows 适配层**：`executor.ts` 用 Python bridge 实现 `ComputerExecutor`；`gates.ts` 从环境变量读门控；`session.ts` 维护会话状态；`pythonBridge.ts` 负责自举与调用；`imageSave.ts` 实现 `save_to_disk` 落盘；`computerUseLock.ts` 管会话锁。
- DPI：Python 进程在 import 任何 GUI 库**之前**设置 Per-Monitor v2 DPI awareness（失败时回退 shcore level 2 / `SetProcessDPIAware`）。这一步必须在 import 前完成，否则 pyautogui 的初始化会抢先锁定 DPI 模式，导致混合缩放屏上截图与点击坐标不一致。

## Windows 适配要点

这几条都是实机验证后针对性处理的，改动前请先读原因。

- **窗口归属要穿透 `ApplicationFrameWindow`**（`resolve_window_pid`）。Store 应用的可见窗口是 `ApplicationFrameWindow`，归属进程是 `ApplicationFrameHost.exe` 而非应用自身。不做这一跳，应用能出现在 `list_installed_apps` / `list_running_apps` 里，却没有任何窗口归给它：`find_window_displays` 漏报、`app_under_point` 认错进程、`prepare_for_action` 无法聚焦、前台门控直接拒绝输入 —— 结果就是「授权成功但完全无法操作」。WinUI3 自带窗口的应用（如记事本）不受影响，所以这个问题只在部分 Store 应用上暴露。
- **stdio 一律 UTF-8**。Python 在 stdout 为管道时按 locale 编码（中文 Windows 是 cp936）输出，而 helper 用 `ensure_ascii=False` 写 JSON：不固定编码时，显示器标签里的 `·`、中文应用名、剪贴板内容都会变成 U+FFFD。调用侧设 `PYTHONIOENCODING=utf-8`，helper 自身也 `reconfigure` 一遍作为兜底。
- **Win32 调用必须声明 `argtypes` / `restype`**。ctypes 未声明时按 `c_int`（32 位）解析返回值，x64 上会截断 HANDLE —— 曾经把剪贴板句柄截成 `0xFFFFFFFF84DA0810`，`GlobalLock` 直接 access violation。涉及指针返回的剪贴板 / 句柄 API 已显式声明。
- **`prepare_for_action` 不隐藏窗口**，只把已授权应用置前（返回空数组）。`COMPUTER_USE_FOCUS_BEFORE_ACTION` 的名字反映这一语义，`focusBeforeAction` 子门控字段同理。
- **`autoResolve` 已实现**：未固定显示器且允许自动解析时，helper 用 `find_window_displays` 选「已授权应用窗口所在的那块屏」。不实现的话默认永远截主屏，`COMPUTER_USE_AUTO_TARGET_DISPLAY` 就是空开关。`focusBeforeAction` 仍是 macOS 选项，helper 忽略。
- **`type` 按连续文本批量下发**。每个 executor 调用在 Python bridge 上都是一次进程启动，逐字素调用会让 27 字符花掉 7 秒；现在连续的普通字符合并成一次调用（helper 内部仍逐字符 8ms），换行 / 制表符各自单独成键。
- **`check_permissions` 恒返回已授权**，`tcc_not_granted` 分支在 Windows 上是死路径。
- **`computer-use/appNames.ts` 已按 Windows 改写**（Program Files / AppData / Steam 白名单，System32 / Winsxs / Installer 黑名单，注册表噪声名称黑名单）。Windows 的 `bundleId` 是规范化后的可执行文件路径，不是 bundle id，因此「始终保留」名单按显示名匹配。注意候选清单只来自注册表，Store 应用（`WindowsApps` 下的包）与只有 App Paths 条目的应用可能缺席 —— 名字仍然可以授权（解析时会并入运行中进程），但清单里看不到。
- **分层的取舍**：写盘（`save_to_disk`）由 host 注入回调实现，vendor 层不直接依赖 `node:fs`，与 `cropRawPatch` 的注入方式一致。
