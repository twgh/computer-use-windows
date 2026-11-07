# 架构与代码导航

本文件写给**改这个仓库的人**：代码分几层、调用怎么走、哪些不变式不能破。它不随技能分发 —— `package_skill.py` 的顶层白名单只收 `SKILL.md`、`references/`、`project/`。

维护者内容刻意不写进 `references/`：那几份文件会随 zip 装到用户机器上，而安装目录里没有源码，任何指向 `project/src/...` 的定位对读者都是死链。

## 文档分工

| 文件 | 读者 | 内容 | 随包分发 |
| --- | --- | --- | --- |
| `SKILL.md` | 使用技能的 agent | 工作流、坐标规则、工具速查 | 是 |
| `references/*.md` | 使用技能的 agent（按需加载） | 工具参数、运行时机制、排障 | 是 |
| `README.md` | 项目使用者 | 能力、配置、实机验证、更新日志 | 否 |
| `AGENTS.md` | 改仓库的 agent | 发版流程、坐标硬规则、提交约定 | 否 |
| `ARCHITECTURE.md` | 改仓库的人 | 源码分层、调用链、不变式 | 否 |

## 源码树

```text
project/src/
  cli.ts                    # 进程入口：runServer()，异常写 stderr 后 exit(1)
  runtime.ts                # 传输无关门面：装配 adapter / session / 工具清单，绑定唯一 dispatcher
  server.ts                 # MCP 接线：把 runtime.invokeRaw 交给 server 工厂
  session.ts                # 会话状态（白名单、flag、显示器、截图 dims）与锁回调
  lib/                      # log / errors / execFileNoThrow / sleep / withResolvers
  computer-use/             # Windows 适配层
    executor.ts             # ComputerExecutor 实现，转调 Python bridge
    pythonBridge.ts         # venv 自举 + 一次性进程调用
    gates.ts                # 环境变量 → 门控常量 / 子门控
    hostAdapter.ts          # adapter 单例（serverName / logger / executor / 权限检查）
    appNames.ts             # 应用名过滤（安装路径白名单 + 组件噪声黑名单）
    windowApps.ts           # 当前有可见窗口的进程（Store 应用的唯一可读来源）
    imageSave.ts            # save_to_disk 落盘
    computerUseLock.ts      # 跨进程会话锁（O_EXCL + 心跳 + 空闲接管）
    common.ts               # 共享常量（serverName 等）
  vendor/computer-use-mcp/  # 平台无关的工具与门控框架
    mcpServer.ts            # MCP server 工厂 + bindSessionContext
    toolCalls.ts            # handleToolCall：全部门控在此，早于任何 executor 调用
    tools.ts                # 25 个工具的 schema 与描述
    coordinateFrame.ts      # 坐标规则文案 + 坐标帧校验
    imageResize.ts          # 视觉预算缩放
    pixelCompare.ts         # 点击前像素陈旧校验
    keyBlocklist.ts         # 系统组合键黑名单
    deniedApps.ts           # 应用分类 → tier
    sentinelApps.ts         # shell 类应用标记
    subGates.ts             # 子门控默认值
    types.ts                # adapter / session context / overrides 类型
    executor.ts             # ComputerExecutor 接口
    index.ts                # 对外导出
project/runtime/
  windows_helper.py         # Windows 桌面后端（单文件，命令式）
  requirements.txt          # venv 自举的依赖指纹
```

`vendor/` 只做定点编辑，不重写：它是从上游移植的框架层，改动越多越难和后续同步。

## 调用链

MCP 入口：

```text
cli.ts
  └─ runtime.createComputerUseRuntime()
       ├─ getComputerUseHostAdapter()      # 进程单例
       ├─ createSessionContext()           # 会话状态袋
       ├─ getInstalledAppNames()           # 拼进 request_access 的描述
       ├─ buildComputerUseTools(...)
       └─ bindSessionContext(...)          # ← 唯一 dispatcher，持有 lastScreenshot
  └─ server.ts
       └─ createComputerUseMcpServer(adapter, mode, undefined, tools, invokeRaw)
            ├─ tools/list                   # 禁用时返回空数组
            └─ tools/call                   # 结果末尾追加 [COORD FRAME]
  └─ StdioServerTransport
```

进程内入口（不走 MCP 的宿主）：

```text
runtime.invoke(name, args)
  └─ invokeRaw()                # 同一个 dispatcher
       └─ finalizeToolResult()  # 剥掉截图 blob + 追加同一条 [COORD FRAME]
```

`createComputerUseMcpServer` 的第 5 个参数 `dispatch` 优先于 `context`：传了它就不会再 `bindSessionContext` 一次。

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
- **候选清单 = 注册表安装项 ∪ 有可见窗口的进程**（`list_window_apps`）。注册表给不出 Store 应用的可读名称（计算器在 `WindowsApps` 下，既无 Uninstall 条目也无 App Paths 条目），而可见窗口是「用户能指认的应用」的最强信号。窗口来源的条目带 `origin: 'window'`：跳过安装路径白名单（便携应用可能在 `D:\appsd\` 这类任意目录），但仍要过名称黑名单。
- **显示名优先取 exe 版本资源**（`file_description`，按路径缓存）。只作用于 App Paths 分支与 `display_name_from_path`，不覆盖 Uninstall 的 `DisplayName` —— 后者已是本地化用户可见名，覆盖后反而变差。
- **候选清单的路径规则**：Program Files / AppData / Steam 白名单，System32 / Winsxs / Installer 黑名单，外加注册表与 Windows 组件噪声名称黑名单。Windows 的 `bundleId` 是规范化后的可执行文件路径，不是 bundle id，因此「始终保留」名单按显示名匹配。
- **DPI 必须在 import GUI 库之前设定**：Python 进程在 import 任何 GUI 库**之前**设置 Per-Monitor v2 DPI awareness（失败时回退 shcore level 2 / `SetProcessDPIAware`）。这一步必须在 import 前完成，否则 pyautogui 的初始化会抢先锁定 DPI 模式，导致混合缩放屏上截图与点击坐标不一致。

## 不可破的不变式

| 不变式 | 落点 | 破了会怎样 |
| --- | --- | --- |
| 一个进程只有一个 dispatcher | `runtime.ts` | 两个 `lastScreenshot` 闭包：一方截图后，另一方的点击被判「越界」 |
| 坐标换算只有一处 | `toolCalls.ts` 的 `scaleCoord` | 二次换算，落点随模型当时「相信」的比例来回漂 |
| 每次返回末尾追加 `[COORD FRAME]`，且不改 `content[0]` | `mcpServer.ts` + `runtime.ts` | 长会话漂移；或破坏 `computer_batch` 依赖的 `content[0]` 单行 JSON |
| 门控全部早于 executor | `toolCalls.ts` 的 `handleToolCall` | 未授权输入被执行 |
| `project/dist/cli.js` 是自包含 bundle | `package_skill.py` 的 `validate_bundle_entry` | 自动升级只覆盖 zip 内文件，旧编译产物会一直跑 |
| 分发白名单 | `package_skill.py` 的 `TOP_LEVEL_ENTRIES` / `PROJECT_RUNTIME_ENTRIES` | 开发期文件混进包（`.github/workflows/test.yml` 就这样进过归档） |

两处 `[COORD FRAME]` 产出点（`mcpServer.ts` 与 `runtime.ts` 的 `finalizeToolResult`）必须给出同一字符串：vendor 层不能反向依赖宿主，重复是结构性的，`scripts/tests/units.test.mjs` 有断言钉住。

## 分发边界

进 zip 的只有 9 个文件：

```text
SKILL.md
references/{tools,runtime,troubleshooting}.md
references/mcp-config.json
project/package.json
project/dist/cli.js
project/runtime/windows_helper.py
project/runtime/requirements.txt
```

不进包：`project/src/`、`tsconfig.json`、`package-lock.json`、构建脚本、`node_modules/`、`.runtime/`、`dist/` 下其它产物，以及仓库根的 `.github/`、`AGENTS.md`、`README.md`、`ARCHITECTURE.md`、`LICENSE`、`scripts/`。
