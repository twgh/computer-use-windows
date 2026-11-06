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
| `~/.computer-use-windows/computer-use.lock` | 会话锁（JSON：`{sessionId, pid, lastHeartbeat}`） | `O_EXCL` 独占创建；持有进程退出后自动回收；心跳超过空闲阈值后可被其他会话接管 |
| `%TEMP%\computer-use-windows\` | `save_to_disk: true` 保存的截图 | 仅在显式请求落盘时写入，文件名 `<screenshot\|zoom>-<时间戳>-<序号>.jpg` |

除此之外 runtime 不写任何文件：日志只写 stderr，截图默认以 MCP image content 返回。落盘目录刻意不在 skill / project 树内 —— `.runtime/` 只留给自举 venv。

## 环境变量

### 主开关

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_ENABLED` | `0` 关闭，其他值开启 | 开启 | 全局 kill switch；关闭时 `tools/list` 返回空数组 |
| `COMPUTER_USE_COORDINATE_MODE` | `pixels` \| `normalized_0_100` | `pixels` | 坐标语义；同时决定工具描述里呈现的坐标系文案 |
| `COMPUTER_USE_DEBUG` | `1` 开启 | 关闭 | 调试日志到 stderr（前缀 `[computer-use]`） |

**环境变量的生效边界**：所有变量都在 **server 进程启动时**从 MCP 配置的 `env` 注入，之后成为该进程 `process.env` 的副本。下文说的「每次调用 / 每次截图重新读取」，只是说代码没有把值缓存成模块常量，读的仍是这份副本 —— 运行中的进程看不到外部对配置或系统环境变量的修改。因此**改任何配置都要重启 server 进程**（多数客户端需要重新加载 MCP 配置）；只有进程内直接改 `process.env` 才可能免重启，普通用法做不到。

`COMPUTER_USE_ENABLED` 与 `COMPUTER_USE_COORDINATE_MODE` 还在**模块加载时求值一次**（`project/src/computer-use/gates.ts`），是真正的常量；其余开关至少在进程内是每次读取的，但对使用者而言同样需要重启。

坐标模式必须与工具描述保持一致：描述文案在构建工具清单时按同一常量固化，两者不一致会导致点击落点错误。

### 子开关

每次调用（或每次截图）重新读取；env 值仍来自进程启动时，改配置需重启 server：

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_CLIPBOARD_PASTE` | `0` 关闭 | 开启 | 多行 `type` 走剪贴板快路径 |
| `COMPUTER_USE_CLIPBOARD_GUARD` | `0` 关闭 | 开启 | `click` tier 前台时暂存并清空用户剪贴板 |
| `COMPUTER_USE_PIXEL_VALIDATION` | `1` 开启 | 关闭 | 点击前 9×9 像素陈旧校验 |
| `COMPUTER_USE_AUTO_TARGET_DISPLAY` | `0` 关闭 | 开启 | 截图前把目标显示器自动切到「已授权应用窗口所在的那块屏」；模型用 `switch_display` 显式指定时以模型为准 |
| `COMPUTER_USE_MOUSE_ANIMATION` | `1` 开启 | **关闭** | 指针缓动：按距离计算 pyautogui tween 时长（2000 px/秒，上限 0.5 秒）。默认关闭（光标瞬移）；只有少数需要"真实指针轨迹"的软件才值得开（悬停才展开的菜单、监听移动的拖放目标），开启后每次点击 / 拖拽 / 移动最多多等约 0.5 秒 |
| `COMPUTER_USE_FOCUS_BEFORE_ACTION` | `0` 关闭 | 开启 | 动作前把已授权应用窗口置前（Windows 语义，不隐藏任何窗口）。注意这会让某个已授权窗口跳到前台，从而遮挡其他窗口 |
| `COMPUTER_USE_COORD_GRID` | `1` 开启 | **关闭** | 可选：全屏截图叠加淡坐标网格与像素标签；默认关闭以保持图像干净，`normalized_0_100` 模式始终不画 |

`COMPUTER_USE_COORD_GRID` 由 `getCoordinateGridEnabled()` 在**每次截图**时读取并随 payload 下发给 helper；其余子开关由 `getChicagoSubGates()` 在每次调用时读取。这些读取都落在进程自己的 `process.env` 上，改 MCP 配置后仍需重启 server（见上文「环境变量的生效边界」）。

### 图像预算

截图与 `zoom` 的输出尺寸由视觉编码器的输入预算决定：`pxPerToken = 28`（每 28×28 像素的 tile 算 1 个 token）、长边上限 1568px、总 tile 数上限 1568。即 `ceil(w/28) × ceil(h/28) ≤ 1568` 且长边 ≤ 1568，取同时满足两式的最大尺寸。

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_IMAGE_MAX_PX` | 正整数，或 `native` | 1568 | 长边上限；`native` = 不做预处理 |
| `COMPUTER_USE_IMAGE_MAX_TOKENS` | 正整数，或 `native` | 1568 | tile 预算；`native` = 不做预处理 |

2560x1600 的屏按原尺寸送是 92×58 = 5336 tokens（预算的 3.4 倍），于是被缩到 1389x868（50×31 = 1550）—— 这也是每张截图的代价被钉在约 1550 tokens、与屏幕大小无关的原因。

**默认值不是本 runtime 的偏好，而是移植自消费方模型自己的图像转码器**（`imageResize.ts` 开头）。预先缩到这两个数，才能保证 `ScreenshotResult.width/height` 等于模型真正看到的那张图的尺寸，`scaleCoord` 的比例才成立。

调高预算的前提是**下游模型确实接受更大的图**（本地 VLM，或 tiling 参数不同的服务）。发出超过消费方上限的图会在到达时被重新缩放，模型随后按更大的图读数取坐标，而我们报告的尺寸更小 —— 每次点击都会按错误比例偏移（1568 与 1389 之比约 13%）。因此：

- 覆盖默认值时启动会打印一条 warn 说明这一点；
- 调高预算应同时使用 `COMPUTER_USE_COORDINATE_MODE=normalized_0_100`：百分比坐标的换算不依赖图像像素尺寸，不受下游重缩影响；
- 想"看清细节"应先考虑 `zoom`：它把区域裁出来再放大，预算作用在那一小块上，同一屏幕面积的有效像素比整屏截图高得多。

两个变量每次截图前重新读取；但 env 值来自进程启动时，改配置后仍需重启 server。

> 本节的数字（预算、缩放后的尺寸、比例）**只服务于运行者与排障**，不是给模型用的换算依据。模型侧拿到的规则是"截图图像像素原样传回"，server 与 `coordinateFrame.ts` 会在每个工具结果里重复它；模型若拿本节的比例自行乘坐标，会被二次换算。

### 坐标网格

**默认关闭**，设 `COMPUTER_USE_COORD_GRID=1` 才开启。理由：网格会污染 UI 开发 / 视觉审查用的截图，可能被误认成 UI 分隔线，也会进入 `save_to_disk` 的存证图；长会话的坐标漂移已由每轮的 `[COORD FRAME]` 提醒与坐标帧校验处理，不依赖这层叠加。仅在需要精确点小控件、且愿意接受图像被改动时开启。

`capture_monitor`（`project/runtime/windows_helper.py`）在**缩放之后、JPEG 编码之前**调用 `draw_coordinate_grid`：每 100px 一条淡线，顶部 / 左侧每 200px 标一个像素标签，标签数字就是图像像素坐标。绘制不改变 `image.size`，所以 `ScreenshotResult.width/height` 与 `scaleCoord` 的换算基准不变。只有 `screenshot` / `resolve_prepare_capture` 两条全屏路径下发 `coordGrid: true`；`zoom` 是重新采集的区域放大图，保持干净。像素陈旧校验的 fresh 图走同一命令、两侧刻度一致；绘制异常会被捕获并降级为无刻度截图，不会让截图失败。`save_to_disk` 写的是同一份 base64，用户拿到的文件也带刻度。

### 其他

| 变量 | 作用 |
| --- | --- |
| `CODEX_THREAD_ID` | 会话身份 ID，用于判定"锁是否由自己持有"；缺失时退化为 `pid-<pid>` |
| `PYTHONDONTWRITEBYTECODE` / `PYAUTOGUI_HIDE_SUPPORT_PROMPT` | Python 侧噪声抑制，helper 内 `setdefault` 为 `1` |

### 会话锁

桌面同一时刻只允许一个会话操作，实现在 `project/src/computer-use/computerUseLock.ts`。生命周期：

1. **获取**：首个非 defer 工具（`request_access` / `list_granted_applications` / `release_lock` 只检查不获取）通过门控时 `O_EXCL` 独占创建锁文件。
2. **心跳**：本会话每次经过锁门控（含 defer 工具）都刷新 `lastHeartbeat`（`touchComputerUseLock`，尽力而为，失败只让锁更早可被接管）。
3. **释放**：三条路 —— 持有进程退出（PID 探活失败 → 自动回收）；agent 主动调 `release_lock`；**空闲接管** —— 持有者进程还活着但心跳超过 `COMPUTER_USE_LOCK_IDLE_SECS`（默认 300 秒），其他会话的 check/acquire 会把它当 stale 处理（删除并重建）。

设计取向：心跳粘住的是「真正闲置」的会话（两个 IDE 常驻、其中一个早就不用的场景）；活跃会话的每次工具调用都在刷新心跳，不会被中途抢走。`0` 完全禁用空闲接管；pre-0.5.0 的旧锁文件没有心跳字段，视为「无闲置证据」，同样不接管。

已知边界：单次工具调用内部的耗时动作（超长 `wait`、超长 batch）期间心跳不刷新，动作时长超过空闲阈值时理论上可被接管；输入注入本身仍受每次动作前的锁门控约束，不会出现两个会话同时注入。

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
| `list_installed_apps` | — | `[{bundleId, displayName, path}]`（注册表 Uninstall + App Paths；后者的显示名取自 exe 版本资源） |
| `list_running_apps` | — | `[{bundleId, displayName}]` |
| `list_window_apps` | — | `[{bundleId, displayName, path}]`，当前拥有可见顶层窗口的进程（含 Store 应用） |
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
- 无上一张截图：`dispatchAction` 的坐标帧校验直接拒绝（`bad_args`）；`scaleCoord` 内也不再有 `rawX / display.scaleFactor` 退化，缺锚点时抛错而不是猜一个落点。这个退化以前会给出"看起来点得动"的假反馈，反过来强化模型自己做 DPI 换算的习惯。

坐标帧校验在 `coordinateFrame.ts`：检查无锚点、图像越界（错误文本明确"边界不是换算系数"）与百分比越界；每个工具结果末尾还会由 `mcpServer.ts` 追加一条 `[COORD FRAME]` 文本块，重复"原样传图上的像素、禁止任何换算"的规则。消费坐标的工具：五种点击、`scroll`、`left_click_drag`（起点与终点）、`mouse_move`。`zoom` 的 `region` 单独用同一比例换算，且不改变坐标系。

## 分层说明

- `project/src/vendor/computer-use-mcp/` 是**平台无关**的工具 / 门控框架，本身不做任何桌面操作，全部通过注入的 executor 与 host adapter 完成。坐标换算、图像缩放、像素比对、按键黑名单都在这一层。
- `project/src/computer-use/` 是 **Windows 适配层**：`executor.ts` 用 Python bridge 实现 `ComputerExecutor`；`gates.ts` 从环境变量读门控；`session.ts` 维护会话状态；`pythonBridge.ts` 负责自举与调用；`imageSave.ts` 实现 `save_to_disk` 落盘；`computerUseLock.ts` 管会话锁。
- DPI：Python 进程在 import 任何 GUI 库**之前**设置 Per-Monitor v2 DPI awareness（失败时回退 shcore level 2 / `SetProcessDPIAware`）。这一步必须在 import 前完成，否则 pyautogui 的初始化会抢先锁定 DPI 模式，导致混合缩放屏上截图与点击坐标不一致。

## Windows 适配要点

这几条都是实机验证后针对性处理的，改动前请先读原因。

- **窗口归属要穿透 `ApplicationFrameWindow`**（`resolve_window_pid`）。Store 应用的可见窗口是 `ApplicationFrameWindow`，归属进程是 `ApplicationFrameHost.exe` 而非应用自身。不做这一跳，应用能出现在 `list_installed_apps` / `list_running_apps` 里，却没有任何窗口归给它：`find_window_displays` 漏报、`app_under_point` 认错进程、`prepare_for_action` 无法聚焦、前台门控直接拒绝输入 —— 结果就是「授权成功但完全无法操作」。WinUI3 自带窗口的应用（如记事本）不受影响，所以这个问题只在部分 Store 应用上暴露。
- **stdio 一律 UTF-8**。Python 在 stdout 为管道时按 locale 编码（中文 Windows 是 cp936）输出，而 helper 用 `ensure_ascii=False` 写 JSON：不固定编码时，显示器标签里的 `·`、中文应用名、剪贴板内容都会变成 U+FFFD。调用侧设 `PYTHONIOENCODING=utf-8`，helper 自身也 `reconfigure` 一遍作为兜底。
- **Win32 调用必须声明 `argtypes` / `restype`**。ctypes 未声明时按 `c_int`（32 位）解析返回值，x64 上会截断 HANDLE —— 曾经把剪贴板句柄截成 `0xFFFFFFFF84DA0810`，`GlobalLock` 直接 access violation。涉及指针返回的剪贴板 / 句柄 API 已显式声明。
- **截图目标尺寸取显示器自身像素，不再乘 `scaleFactor`**。`DisplayGeometry.width/height` 在本后端已是物理像素（mss 按此抓取，PMv2 的 `GetWindowRect` 亦相符），乘缩放系数是 macOS 移植残留（那边是逻辑点）。乘上去只会放大：1280x800 的屏会被插值到 1389x868 —— 凭空多出像素、载荷更大、细节为零。分辨率足够大的屏因 token 预算限制而结果相同，所以这个偏差一直没暴露。`zoom` 的放大是刻意保留的（该工具就是为了让读不清的字变大），走独立的 `zoomTargetDims`。
- **`prepare_for_action` 不隐藏窗口**，只把已授权应用置前（返回空数组）。`COMPUTER_USE_FOCUS_BEFORE_ACTION` 的名字反映这一语义，`focusBeforeAction` 子门控字段同理。注意：由于窗口不会被隐藏，**原子截图路径（`autoTargetDisplay` 开启，默认）不执行这一步** —— 在截图前把某个已授权窗口提到前台只会遮挡模型正在看的内容，而输入动作会自己调用它。这是与 macOS（隐藏非授权窗口、使截图更"真实"）的有意差异。
- **`autoResolve` 已实现**：未固定显示器且允许自动解析时，helper 用 `find_window_displays` 选「已授权应用窗口所在的那块屏」。不实现的话默认永远截主屏，`COMPUTER_USE_AUTO_TARGET_DISPLAY` 就是空开关。`focusBeforeAction` 仍是 macOS 选项，helper 忽略。
- **`type` 按连续文本批量下发**。每个 executor 调用在 Python bridge 上都是一次进程启动，逐字素调用会让 27 字符花掉 7 秒；现在连续的普通字符合并成一次调用（helper 内部仍逐字符 8ms），换行 / 制表符各自单独成键。
- **`scroll` 不走 `pyautogui.scroll()`**。pyautogui 的 win32 实现把 `clicks` 原样塞进 `mouse_event` 的 `dwData`，**不乘 `WHEEL_DELTA(120)`**：`scroll_amount: 3`（3 格）实际发出 delta=3，即 1/40 格。自绘控件（XCGUI / DirectUI）按 `delta / 120` 取整算行数，直接归零 —— 症状是「工具返回成功，页面纹丝不动」；浏览器会累加小数 deltaY，所以这条路径在浏览器里看起来是好的。此外 pyautogui 的符号约定与 executor 的屏幕坐标 `dy` 相反（正数 = 向上滚），且它 `except (PermissionError, OSError): pass` 吞掉注入错误，永远不会报错。现在两个轴都自己乘 120、纵向按 `dy` 取负。实测（demo.exe 的 XCGUI 窗口，同一落点）：delta ±3 / ±30 → 0.00% 像素变化；-120 → 15.83%，-360 → 14.75%。
- **`check_permissions` 恒返回已授权，且结果被记忆化。** vendored 框架的 Gate 2 会在**每次工具调用**前问一次 OS 权限，而 Windows 后端没有 TCC 可问 —— helper 返回常量 `{accessibility: true, screenRecording: true}`。这一次询问是完整的 Python 进程（实测 229ms，一次 `wait` 调用几乎全部时间都花在这里），所以 adapter 把它记忆化为每进程一次，省掉约 20% 的单次调用延迟。因此 `tcc_not_granted` 在 Windows 上永不触发、`tccState` 永不填充，该分支保留作为平台接缝；**若将来接入真实前置条件（会话 0 / 无交互桌面、RDP 断开、UAC 安全桌面），必须移除记忆化**（那些状态会在进程运行期间变化）。
- **注册表路径必须先展开环境变量**（`expand_registry_path`，作用于 `DisplayIcon`、App Paths 默认值与 `InstallLocation` 三处）。PowerShell 的 App Paths 默认值就是 `%systemroot%\system32\WindowsPowerShell\v1.0\powershell.exe`，而授权比对用的是 `QueryFullProcessImageName` 的真实路径 —— 不展开时这条 bundleId 永远匹配不上任何进程：应用显示为已授权却无法操作，`focus_existing_window` 找不到窗口，`prepare_for_action` 还会转而去聚焦别的应用。附带效应：路径能打开了，`file_description` 才第一次读得动，显示名从退化的 `PowerShell` 变成真实的「Windows PowerShell」。未知变量 `expandvars` 原样保留，好过整条丢弃。
- **`_force_foreground` 返回 bool 且不抛异常**。它原先只有第一次 `SetForegroundWindow` 有兜底，`AttachThreadInput` 之后的第二次在 `try/finally` 里没有 `except` —— 而后台进程抢不到前台是**常态**，于是每个输入动作都可能把原始 pywin32 元组直接甩给模型：`Tool "left_click" failed: (0, 'SetForegroundWindow', 'No error message is available')`，读起来像工具坏了且没有任何可行动信息。现在 `prepare_for_action` 忽略返回值（紧随其后的前台门控会重读真实前台，报出正确的 `app_not_granted`），`focus_existing_window` 则把结果透传给 `open_application`，让它能为"已置前"这个承诺说真话。
- **`open_app` 的两条 `Popen` 兜底必须 `DEVNULL` 掉 stdio**。bridge 用 `execFile` 读 helper，而它 resolve 的时机是 **'close'（所有 stdio 流 EOF）**，不是 helper 自己退出。被启动的程序继承了 helper 的 stdout 句柄，这条流就一直开着到那个程序结束 —— 于是工具挂到客户端超时、返回 `-32603 did not complete`，而应用其实已经打开，模型只能重试并再开一个。`os.startfile` 走 ShellExecute 不下传句柄，所以只有兜底分支会中招（此前 `%systemroot%` 那个 bug 每次都把 `os.path.exists` 判假、正好逼进兜底，所以看起来像"冷启动慢"）。
- **控制台应用的 `open_application` 改为聚焦宿主窗口，不再重复启动。** shell 没有自己的窗口（由 `WindowsTerminal.exe` 承载），按进程路径匹配永远找不到，于是每次调用都新开一个 tab。现在匹配不到窗口时：进程在跑 且 存在宿主窗口 → 聚焦宿主窗口。这不是驱动未授权会话的后门 —— 输入仍按前台进程单独门控，而前台是宿主。残留不精确：多 tab 时可见的那个未必是被授权应用的。
- **`open_app` 返回 `focused` / `present` / `launched`，且 `present` 绝不启动。** 应用在运行但窗口提不起来时（后台进程抢焦点被 Windows 拒绝），旧实现照样 `os.startfile` 一遍 —— 于是"打不开"变成"多开一个"。现在 `focus_existing_window` 返回三态，`present` 直接回给工具层报 `state_conflict`。vendor 侧 `openApp` 的签名相应变成 `Promise<OpenAppOutcome | void>`，返回 `void` 的 host（macOS）会拿到一句明确"无法确认已置前"的中性文本，而不是冒领成功。
- **`conhost.exe` 也要归 terminal 档。** 它的显示名是「Console Window Host」，不含 "terminal" 子串，落到默认分类就是 **full 档 = 完整键盘进 shell**。`TERMINAL_NAME_SUBSTRINGS` 里补了 `conhost` 与 `console window host`；刻意没加裸词 "console"，`.includes()` 下太容易误伤。
- **窗口归属只穿透 `ApplicationFrameWindow`，不穿透终端宿主。** Win11 24H2 起控制台由 Windows Terminal 承载，`GetWindowThreadProcessId` 拿到的是宿主；实测宿主的父进程是 `svchost`（默认终端交接），shell 不在它的子树里 —— 没有可靠的窗口→shell 映射，猜错就是把输入送进另一个可能已提权的 shell。所以 `resolve_window_pid` 只管 Store 应用那一侧，控制台侧改由 `consoleHostNote()` 在前台门控与落点校验处给出专门说明（授权宿主 = terminal 档，或改用自己的 shell 工具），替代原来那句对控制台场景纯属误导的「it may have appeared since your last one」。上面那条聚焦兜底用的正是同一个宿主判定。
- **候选清单 = 注册表安装项 ∪ 有可见窗口的进程**（`list_window_apps`，`source/computer-use/windowApps.ts`）。注册表给不出 Store 应用的可读名称（计算器在 `WindowsApps` 下，既无 Uninstall 条目也无 App Paths 条目），而可见窗口是「用户能指认的应用」的最强信号。窗口来源的条目带 `origin: 'window'`：跳过安装路径白名单（便携应用可能在 `D:\appsd\` 这类任意目录），但仍要过名称黑名单。
- **显示名优先取 exe 版本资源**（`file_description`，按路径缓存）。只作用于 App Paths 分支与 `display_name_from_path`，不覆盖 Uninstall 的 `DisplayName` —— 后者已是本地化用户可见名，覆盖后反而变差。
- **`computer-use/appNames.ts` 的路径规则**：Program Files / AppData / Steam 白名单，System32 / Winsxs / Installer 黑名单，外加注册表与 Windows 组件噪声名称黑名单。Windows 的 `bundleId` 是规范化后的可执行文件路径，不是 bundle id，因此「始终保留」名单按显示名匹配。
- **分层的取舍**：写盘（`save_to_disk`）由 host 注入回调实现，vendor 层不直接依赖 `node:fs`，与 `cropRawPatch` 的注入方式一致。
