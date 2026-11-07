# Runtime 参考

本文件描述 `computer-use-windows` 的运行机制：目录结构、环境变量、自举链路、Python helper 协议与运行时分层。文中出现的路径要么在**分发包内真实存在**，要么是运行时会创建的本地状态；源码只在仓库里，不随包分发。

## 目录结构

分发包是运行时副本，只带以下文件：

```text
SKILL.md                           # 技能入口（agent 先读这个）
references/tools.md                # 25 个工具的完整参数与返回结构
references/runtime.md              # 本文件
references/troubleshooting.md      # 常见故障的定位与处置
project/package.json               # "type": "module" + 项目根锚点
project/dist/cli.js                # 自包含 bundle，升级时由包覆盖
project/runtime/windows_helper.py  # Python 桌面后端（单文件，命令式）
project/runtime/requirements.txt   # venv 自举的依赖指纹
```

源码、构建配置、`node_modules/`、`.runtime/` 与 `dist/` 下其它产物都不进包：bundle 自包含，源码没有运行时作用。

### 数据落点

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `project/.runtime/venv/` | 自举出的 Python 虚拟环境 | 首次真正调用工具时创建 |
| `project/.runtime/requirements.sha256` | `requirements.txt` 的 SHA-256 记录 | 与当前文件不一致才重装依赖 |
| `%USERPROFILE%\.computer-use-windows\computer-use.lock` | 会话锁（JSON：`{sessionId, pid, lastHeartbeat}`） | `O_EXCL` 独占创建；持有进程退出后自动回收；心跳超过空闲阈值后可被其他会话接管 |
| `%TEMP%\computer-use-windows\` | `save_to_disk: true` 保存的截图 | 仅在显式请求落盘时写入，文件名 `<screenshot\|zoom>-<时间戳>-<序号>.jpg` |

除此之外 runtime 不写任何文件：日志只写 stderr，截图默认以 MCP image content 返回。落盘目录刻意不在 skill / project 树内 —— `.runtime/` 只留给自举 venv。

## 环境变量

### 主开关

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_ENABLED` | `0` 关闭，其他值开启 | 开启 | 全局 kill switch；关闭时 `tools/list` 返回空数组 |
| `COMPUTER_USE_COORDINATE_MODE` | `pixels` \| `normalized_0_100` | `pixels` | 坐标语义；同时决定工具描述里呈现的坐标系文案 |
| `COMPUTER_USE_DEBUG` | `1` 开启 | 关闭 | 调试日志到 stderr（前缀 `[computer-use]`） |

**环境变量的生效边界**：所有变量都在 **server 进程启动时**从 MCP 配置的 `env` 注入，之后成为该进程 `process.env` 的副本。下文说的「每次调用 / 每次截图重新读取」，只是说代码没有把值缓存成模块常量，读的仍是这份副本 —— 运行中的进程看不到外部对配置或系统环境变量的修改。因此**改任何配置都要重启 server 进程**；常用做法是在 MCP 页面把该 server 关掉再打开（或点「重新连接」）；找不到 MCP 页面入口时重启客户端效果相同，两者都会新建进程（详见 `references/troubleshooting.md`「改了环境变量没有生效」）。只有进程内直接改 `process.env` 才可能免重启，普通用法做不到。

`COMPUTER_USE_ENABLED` 与 `COMPUTER_USE_COORDINATE_MODE` 还在**进程启动加载配置时求值一次**，是真正的常量；其余开关至少在进程内是每次读取的，但对使用者而言同样需要重启。

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

**默认值不是本 runtime 的偏好，而是移植自消费方模型自己的图像转码器**。预先缩到这两个数，才能保证 `ScreenshotResult.width/height` 等于模型真正看到的那张图的尺寸，`scaleCoord` 的比例才成立。

调高预算的前提是**下游模型确实接受更大的图**（本地 VLM，或 tiling 参数不同的服务）。发出超过消费方上限的图会在到达时被重新缩放，模型随后按更大的图读数取坐标，而我们报告的尺寸更小 —— 每次点击都会按错误比例偏移（1568 与 1389 之比约 13%）。因此：

- 覆盖默认值时启动会打印一条 warn 说明这一点；
- 调高预算应同时使用 `COMPUTER_USE_COORDINATE_MODE=normalized_0_100`：百分比坐标的换算不依赖图像像素尺寸，不受下游重缩影响；
- 想"看清细节"应先考虑 `zoom`：它把区域裁出来再放大，预算作用在那一小块上，同一屏幕面积的有效像素比整屏截图高得多。

两个变量每次截图前重新读取；但 env 值来自进程启动时，改配置后仍需重启 server。

> 本节的数字（预算、缩放后的尺寸、比例）**只服务于运行者与排障**，不是给模型用的换算依据。模型侧拿到的规则是"截图图像像素原样传回"，server 会在每个工具结果里重复它；模型若拿本节的比例自行乘坐标，会被二次换算。

### 坐标网格

**默认关闭**，设 `COMPUTER_USE_COORD_GRID=1` 才开启。理由：网格会污染 UI 开发 / 视觉审查用的截图，可能被误认成 UI 分隔线，也会进入 `save_to_disk` 的存证图；长会话的坐标漂移已由每轮的 `[COORD FRAME]` 提醒与坐标帧校验处理，不依赖这层叠加。仅在需要精确点小控件、且愿意接受图像被改动时开启。

`capture_monitor`（`project/runtime/windows_helper.py`）在**缩放之后、JPEG 编码之前**调用 `draw_coordinate_grid`：每 100px 一条淡线，顶部 / 左侧每 200px 标一个像素标签，标签数字就是图像像素坐标。绘制不改变 `image.size`，所以 `ScreenshotResult.width/height` 与 `scaleCoord` 的换算基准不变。只有 `screenshot` / `resolve_prepare_capture` 两条全屏路径下发 `coordGrid: true`；`zoom` 是重新采集的区域放大图，保持干净。像素陈旧校验的 fresh 图走同一命令、两侧刻度一致；绘制异常会被捕获并降级为无刻度截图，不会让截图失败。`save_to_disk` 写的是同一份 base64，用户拿到的文件也带刻度。

### 其他

| 变量 | 作用 |
| --- | --- |
| `AGENT_SESSION_ID` | 会话身份 ID，用于判定"锁是否由自己持有"；缺失时退化为 `pid-<pid>` |
| `PYTHONDONTWRITEBYTECODE` / `PYAUTOGUI_HIDE_SUPPORT_PROMPT` | Python 侧噪声抑制，helper 内 `setdefault` 为 `1` |

### 会话锁

桌面同一时刻只允许一个会话操作。生命周期：

1. **获取**：首个非 defer 工具（`request_access` / `list_granted_applications` / `release_lock` 只检查不获取）通过门控时 `O_EXCL` 独占创建锁文件。
2. **心跳**：本会话每次经过锁门控（含 defer 工具）都刷新 `lastHeartbeat`（`touchComputerUseLock`，尽力而为，失败只让锁更早可被接管）。
3. **释放**：三条路 —— 持有进程退出（PID 探活失败 → 自动回收）；agent 主动调 `release_lock`；**空闲接管** —— 持有者进程还活着但心跳超过 `COMPUTER_USE_LOCK_IDLE_SECS`（默认 300 秒），其他会话的 check/acquire 会把它当 stale 处理（删除并重建）。

设计取向：心跳粘住的是「真正闲置」的会话（两个 IDE 常驻、其中一个早就不用的场景）；活跃会话的每次工具调用都在刷新心跳，不会被中途抢走。`0` 完全禁用空闲接管；pre-0.5.0 的旧锁文件没有心跳字段，视为「无闲置证据」，同样不接管。

已知边界：单次工具调用内部的耗时动作（超长 `wait`、超长 batch）期间心跳不刷新，动作时长超过空闲阈值时理论上可被接管；输入注入本身仍受每次动作前的锁门控约束，不会出现两个会话同时注入。

## 启动流程

进程启动后按固定顺序完成接线：

1. 构造 host adapter（缓存单例），组装会话状态与子门控。
2. 读取坐标模式。
3. 枚举本机已安装应用，把可用名称拼进 `request_access` 的描述文本；失败则退回通用文案。
4. 构建工具清单；禁用时 `tools/list` 返回空数组。
5. 绑定**唯一**的传输无关 dispatcher —— 最近一张截图的坐标锚点就存在它的闭包里。
6. 在它之上挂 stdio 的 MCP 传输，注册 `tools/call`（结果末尾追加 `[COORD FRAME]`）与 `tools/list`。

除 MCP 之外还有一条进程内入口：复用同一个 dispatcher，只做「剥掉截图 blob + 追加同一条 `[COORD FRAME]`」。两条入口共享坐标锚点，因此不会分叉。

没有命令行参数解析；唯一的输入通道是 stdio 的 MCP 消息。

## venv 自举

由进程内的单例保护，失败后清空以允许重试。

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

`scaleCoord` 是唯一的坐标入口：

- `normalized_0_100`：`x = round(rawX / 100 * display.width) + display.originX`。
- `pixels`：`x = round(rawX * lastScreenshot.displayWidth / lastScreenshot.width) + lastScreenshot.originX`。比例用的是**截图尺寸**（含长边降采样），不是 `1/scaleFactor`；显示器几何取的是**截图时刻**的快照。
- 无上一张截图：`dispatchAction` 的坐标帧校验直接拒绝（`bad_args`）；`scaleCoord` 内也不再有 `rawX / display.scaleFactor` 退化，缺锚点时抛错而不是猜一个落点。这个退化以前会给出"看起来点得动"的假反馈，反过来强化模型自己做 DPI 换算的习惯。

坐标帧校验：检查无锚点、图像越界（错误文本明确"边界不是换算系数"）与百分比越界；每个工具结果末尾还会追加一条 `[COORD FRAME]` 文本块，重复"原样传图上的像素、禁止任何换算"的规则。消费坐标的工具：五种点击、`scroll`、`left_click_drag`（起点与终点）、`mouse_move`。`zoom` 的 `region` 单独用同一比例换算，且不改变坐标系。
