# 故障排查

按"症状 → 定位 → 处置"组织。所有路径相对 skill 根目录。

## 一、构建与启动

### 在仓库源码树里执行 `npm run build` 失败

正常安装与升级都不需要构建：分发包自带 `project/dist/cli.js`，它是自包含的单文件 bundle，不依赖 `node_modules`，也不含 `src/`、`tsconfig.json`、`package-lock.json`，所以安装目录里无法构建、也不需要构建。只有拿到仓库源码树才需要构建。

- 确认 Node.js >= 20（`node -v`）。
- 先 `npm install` 生成 `node_modules`；`npm run build` 会先跑 tsc 再跑 esbuild 覆盖 `dist/cli.js`。
- 类型检查可单独跑：`cd ./project && npm run check`。

### server 启动了但"没有任何输出"

这是正常行为：MCP over stdio，无请求时静默。需要观察内部流程时设置 `COMPUTER_USE_DEBUG=1`，日志会以 `[computer-use]` 前缀写到 **stderr**（stdout 被协议占用，不要往 stdout 打日志）。

### 客户端里根本没有 computer-use 工具

这通常不是构建或 bundle 问题，而是 **MCP server 没被注册**：分发包里的 `project/dist/cli.js` 只是一个可执行文件，客户端不会自动发现它。按 `SKILL.md`「前置检查：MCP 是否接通」处理，配置片段见 `references/mcp-config.json`。

- 确认 `args[0]` 指向真实存在的 `project/dist/cli.js` 绝对路径（用正斜杠），且指向本次升级后的那个 skill 目录。
- 写入配置时应是**合并** `mcpServers` 下的这一项，不要整份覆盖掉用户已有的其它 server。
- 改过配置后如何让会话拿到工具，取决于客户端：热更新客户端（如 Qoder Desktop）会在**下一条用户消息开启的回合**自动同步会话工具目录，无需重启；启动快照客户端则需要在 MCP 页面把该 server **关掉再打开**（或点「重新连接」）来新建进程；找不到 MCP 页面入口时，重启客户端效果相同。注册后自检失败不要在同一回合里反复重试，详见 `SKILL.md`「没有工具时的自助接入」第 4 步。
- 不要用 `node project/dist/cli.js` 手动起进程代替注册：工具列表由客户端决定，且授权清单、截图锚点、会话锁都在长驻 server 进程内。
- 客户端 MCP 面板显示失败时，在 `env` 里加 `COMPUTER_USE_DEBUG=1` 看 stderr 日志。

### 客户端里看不到任何工具

server 已启动却返回空工具列表时：

- `COMPUTER_USE_ENABLED=0` 时 `tools/list` 返回空数组，这是有意设计的 kill switch。检查客户端注入的环境变量。
- 检查 MCP 配置里的 `args[0]` 是否指向真实存在的 `dist/cli.js` 绝对路径。
- 用 `COMPUTER_USE_DEBUG=1` 启动，确认打了 `starting stdio MCP server`。

### 升级后行为仍是旧版本

分发包里的 `project/dist/cli.js` 会随升级被替换，它内联了 MCP SDK，不依赖 `node_modules`。若 `initialize` 返回的 `serverInfo.version` 仍是旧值、或新工具 / 新行为没出现：

- 确认客户端**重建过 server 进程**：在 MCP 页面把该 server 关掉再打开（或点「重新连接」）；找不到入口就重启客户端。新入口只在进程启动时加载，旧进程不会热更新。
- 确认 `args[0]` 指向本次升级后的那个 skill 目录下的 `dist/cli.js`，没有指向另一份旧副本。
- `src/`、`dist/` 下其它文件、`node_modules/`、`.runtime/` 都是机器本地状态，升级不会清理也不会更新；bundle 不引用它们，无需手工处理，也不要拿残留的旧源码重新构建。

> 维护者：改过版本号后没重新 `npm run build`，`package_skill.py` 会拒绝出包；本地构建出的 `dist/cli.js` 不会自动带上新版本。

### 改了环境变量没有生效

所有环境变量都在 **server 进程启动时**从 MCP 配置的 `env` 注入：改配置后必须重启 server 进程。

**怎么重建 server 进程**（两种做法任选其一）：

1. 在 MCP 页面把 `computer-use-windows` **关掉再打开**，或点该 server 的「重新连接」按钮 —— 客户端会终止旧进程并新建一个。
2. **找不到 MCP 页面入口时，直接重启客户端 / IDE** —— 它会在启动时重新拉起所有 MCP server，效果相同，只是动作更大一些。

两者**都是重启 server 进程**，不是热更新：新配置与新 bundle 都在进程启动时被读取，会话状态（授权清单、显示器 pin、截图锚点、桌面锁）会随旧进程清空，需要重新 `request_access`。改环境变量、升级 bundle、升级后行为仍是旧版本，都用这两个动作之一处理。

`COMPUTER_USE_ENABLED` 与 `COMPUTER_USE_COORDINATE_MODE` 还在模块加载时求值一次，是真正的常量；子开关（`COMPUTER_USE_MOUSE_ANIMATION`、`COMPUTER_USE_FOCUS_BEFORE_ACTION`、`COMPUTER_USE_CLIPBOARD_GUARD`、`COMPUTER_USE_COORD_GRID`、图像预算等）每次工具调用 / 每次截图重新读取，但读的仍是启动时那份 `process.env` ——「每次读取」只表示没有缓存成模块常量，**不等于改配置免重启**。

## 二、Python 自举

首次调用工具时会创建 `project/.runtime/venv` 并安装依赖，这一步失败会以 `executor_threw` 形式暴露为工具错误。

### `venv creation` 失败

- 系统里没有可用的 Python：确认 `py -3 --version` 或 `python --version` 能跑通。
- Windows 上会先试 `py -3 -m venv`，失败回退 `python -m venv`。两者都不可用时安装 Python 3 并确保在 PATH 中。

### 依赖安装失败

- 多为网络问题（首次要拉 `mss` / `Pillow` / `pyautogui` / `psutil` / `pywin32`）。网络恢复后**重试即可** —— 自举 promise 在失败时会被清空，允许重新触发。
- 安全软件拦截写入 venv 目录时，把 `project/.runtime/` 加入白名单。
- 强制重装：删除 `project/.runtime/venv` 与 `project/.runtime/requirements.sha256`，下次调用重新自举。
- 依赖版本变化时（`requirements.txt` 内容变了导致 SHA-256 不匹配）会自动重装，无需手工干预。

### 每次调用都很慢

正常现象：一次工具调用 = 一个短命 Python 进程（起解释器 + import numpy/Pillow/pywin32 等）。把可预测的连续动作合并进 `computer_batch` 能显著减少总耗时。

## 三、门控类错误

| 错误 | 原因 | 处置 |
| --- | --- | --- |
| `allowlist_empty` | 还没申请任何应用 | 先调 `request_access` |
| `app_not_granted` | 前台应用不在白名单。**也包括"看着在名单里"**：授权记的是可执行文件路径，应用重新构建换目录（`go run` 每次换 `go-build<hash>` 临时目录）、重装、便携应用被移动，都会让原本已授权的应用重新撞上这个错误 | 补一次 `request_access` 把该应用加入（会解析到新的运行路径）；或先 `open_application` 把已授权应用置前。用 `list_granted_applications` 对比名单里的 `bundleId` 与进程实际路径即可确认 |
| `tier_insufficient` | 应用已授权但档位不足（对 `click` tier 的应用发键盘输入 / 右键） | 换用同档位允许的动作，或换目标应用；**不要**试图绕开门控（不要用 `open_application`、shell、脚本、`SendKeys` / `nircmd`，也不要直接调用 `project/runtime/windows_helper.py` 的子命令 —— 它是普通 CLI，绕过去就等于绕过了全部门控） |
| `grant_flag_required` | 缺少 `clipboardRead` / `clipboardWrite` / `systemKeyCombos` | 重新 `request_access` 并显式带上对应 flag |
| `bad_args` | 参数非法；常见于 `switch_display` 传了不存在的显示器名 | 读错误信息里列出的可用显示器名，原样重传 |
| `state_conflict` | 调用顺序问题，如左键已按下时再次 `left_mouse_down` | 先 `left_mouse_up` 复位状态 |
| `cu_lock_held` | 桌面被另一个 computer-use 会话占用 | 等对方结束，或等空闲接管（默认 300 秒无心跳后被接管）。`release_lock` 只能释放**本会话**的锁，此时调用是空操作。若确认持有者进程已崩溃，可删除 `%USERPROFILE%\.computer-use-windows\computer-use.lock` |
| `display_error` | 显示器枚举失败（热插拔瞬间等） | 稍后重试 |
| `feature_unavailable` | 会话未接线该能力 | 在 MCP 页面关掉再打开该 server，或重启客户端（重建进程） |

被拦截的系统级组合键（需 `systemKeyCombos` 授权才可能通过）：`ctrl+alt+delete`、`alt+f4`、`alt+tab`、`win+l`、`win+d`。

## 四、输入不生效

### 报错提示管理员权限 / 输入被丢弃

目标窗口以管理员权限运行，而 runtime 未提权，Windows UIPI 会拦截输入注入，helper 会显式报错。处置：以管理员身份运行 runtime（宿主进程提权），或改操作非提权窗口。截屏与窗口管理不受影响。

可用 `frontmost_app` / `app_under_point`（helper 层）查看 `elevated` 与 `selfElevated` 判断是否为提权边界问题。

### 输入落到了错误的窗口

- 输入工具作用于**当前前台**窗口。先 `open_application` 把目标应用带到前台，必要时先 `left_click` 点进具体输入控件。
- 运行时不隐藏窗口，其他窗口可能挡在目标之上；多屏场景先确认截的是哪块屏（`screenshot` 的说明文本 + `switch_display`）。

### 滚动返回成功但页面不动

`scroll` 返回 `Scrolled.` 而画面没变化，先分清两类原因：

- **注入的滚轮量不足一格**。Windows 的 `WM_MOUSEWHEEL` 按 `delta / WHEEL_DELTA(120)` 决定滚几行：自绘控件（XCGUI / DirectUI）整数取整后归零，浏览器则累加成不可见的小数位移。helper 早期版本走 `pyautogui.scroll()`，而它把"格数"原样当作 delta 传下去，3 格变成 delta=3 —— 症状正是"永远返回成功、永远不动"。现在两个轴都自己乘 120，细节与实测数据见 `references/runtime.md`「Windows 适配要点」。
- **根本没注入**。这种情况下工具返回的是错误而不是 `Scrolled.`，按上面「门控类错误」处理。

判断"到底动没动"时别只看像素差：移动光标本身会触发 hover 重绘、置前会改标题栏配色。做一次对照 —— 先只 `mouse_move` 到同一点并截图，确认画面不变，再 `scroll` 截图比对。

### 授权了控制台应用仍然被拒（Windows Terminal 宿主）

报 `"Windows Terminal Host" is not in the allowed applications` 并附带一段专门说明 —— 即使 `powershell.exe` / `pwsh.exe` 已在白名单。Win11 24H2 起控制台窗口由 `WindowsTerminal.exe` 承载，前台门控与落点校验看到的是宿主进程。实测该宿主的父进程是 `svchost`、shell 不在其子树内，**没有可靠的窗口→shell 映射可穿透**（猜错等于把输入送进另一个可能已提权的 shell），所以这里不做 `resolve_window_pid` 那种穿透，只把情况说清：按提示授权宿主可拿到 terminal（click）档控制，或改用自己的 shell 工具跑命令。详见 `references/runtime.md`「Windows 适配要点」。

连带效应已修：`open_application` 对控制台应用会聚焦宿主窗口而不是每次新开一个 tab（`focus_existing_window` 匹配不到 shell 窗口时，若进程在跑且有宿主窗口就聚焦它）。多 tab 时可见的那个未必是被授权应用的 —— 这是残留的不精确处。

### `open_application` 报未授权，但应用确实在 `granted` 里

先读错误里列出的已授权显示名。`open_application` 现在会在已授权集合内做松匹配（显示名互为子串、或等于可执行文件名）：`Notepad++` → `Notepad++ (64-bit x64)`、`pwsh` → `PowerShell 7`。但松匹配**命中多个时拒绝猜测**，返回 `bad_args` 并列出候选（两者的 tier 与「用户以为批准了什么」可能不同），此时传精确显示名或 bundleId。完整解析顺序见 `references/tools.md`「open_application」。

### 中文 / 全角标点输入异常

`type` 走 Unicode SendInput，与 IME、键盘布局无关，中文与全角标点应完整输入。若仍异常，确认没有把文本拆成 `key` 组合键来发（`key` 只适合按键与快捷键，不适合文本）。

### 剪贴板"丢了"

当前台应用是 `click` tier 时，runtime 会暂存并清空用户剪贴板（防止通过界面"粘贴"按钮绕过键盘档位限制），离开该档位前台后自动恢复。这是预期行为。可用 `COMPUTER_USE_CLIPBOARD_GUARD=0` 关闭，但不建议。

## 五、点击落点不准

按可能性排序：

1. **没有先截图**。`pixels` 模式下坐标是"最近一张截图的图像像素"；无截图时带坐标的动作会被直接拒绝并提示先 `screenshot`，不再有按缩放比粗略换算的兜底。
2. **坐标模式不匹配**。客户端配置的 `COMPUTER_USE_COORDINATE_MODE` 必须与 agent 给出的坐标语义一致；`pixels` 与 `normalized_0_100` 混用会系统性偏移。
3. **把 `zoom` 的放大图当成了坐标基准**。放大图仅用于观察，点击始终以全屏截图为基准。
4. **自己做了换算（最常见，尤其在长会话中）**。不要用分辨率 / 缩放比 / 降采样比例自行推导坐标：乘到物理像素与乘到逻辑点是两个不同系数，模型会在这两者之间反复摇摆，每次点击偏移都不一致。直接读截图图像像素原样交给 server；每个工具结果末尾的 `[COORD FRAME]` 文本块是权威规则。坐标若超出截图图像范围会被直接拒绝并提示"边界不是换算系数"。
5. **截图后显示器设置发生变化**。换算使用截图时刻的几何快照，重新截图即可。
6. **目标在另一块屏**。先 `switch_display` 再截图，坐标才落在同一坐标系内。显示器名称里的分辨率 / 缩放数字只用于认屏幕，不参与坐标计算。
7. **感觉"规则记不清了"**。不要从本文档里翻比例数字，看最近一次工具返回末尾的 `[COORD FRAME]`：图像像素原样传回，不做任何换算。

## 六、截图相关问题

- **黑屏或缺少内容**：独占全屏（部分游戏）、DRM 保护的播放内容、UAC 安全桌面下无法采集。
- **颜色异常**：HDR 显示器上采集可能偏色；需要精确颜色判读时建议先在 SDR 模式下操作。
- **显示器编号对不上 Windows 设置**：内部编号与系统编号来源不同。跨端沟通时用"型号 / 分辨率 / 缩放 / 左右上下方位"描述，不要用编号。
- **看到不该出现的窗口**：本 runtime 上报 `screenshotFiltering: none`，截图不过滤非白名单窗口。这是设计如此，动作门控在 MCP 层而非 compositor 层。
- **多屏时截图带有说明文本但只列出部分屏幕**：说明文本只在显示器 ≥ 2 块且（首次截图或目标屏变化）时出现，属预期行为。
- **`save_to_disk: true` 没有拿到路径**：结果文本里会写明原因 —— 要么该会话没接上写盘能力（`save_to_disk was requested, but this session has no image writer wired`），要么写盘失败并附带系统错误（`Failed to save the image to disk: …`）。两种情况图像本体都照常返回，不会因落盘失败而丢图。目录 `%TEMP%\computer-use-windows\` 不存在时会自动创建。

## 七、重置与清理

- 重建 Python 环境：删除 `project/.runtime/venv` 与 `project/.runtime/requirements.sha256`。
- 释放卡住的会话锁：删除 `%USERPROFILE%\.computer-use-windows\computer-use.lock`（确认无活动会话后再删）。
- 从源码重新构建（正常安装 / 升级不需要）：`cd ./project && npm install && npm run build`。
- 清理 `save_to_disk` 产生的图：删除 `%TEMP%\computer-use-windows\` 整个目录即可，其中没有任何状态。
- 校验 skill 结构：`python ./scripts/validate_skill.py .`（UTF-8 安全，不依赖第三方库；检查 frontmatter、命名规范与 `references/` 引用是否都存在）。
- 打包分发：从仓库根运行 `python scripts/package_skill.py -o <zip>`；产物 `project/` 下只有 `package.json`、`dist/cli.js`、`runtime/windows_helper.py`、`runtime/requirements.txt`，不含 TypeScript 源码、`tsconfig.json`、`package-lock.json`、`node_modules/`、`.runtime/`、`README.md`、`LICENSE`、`scripts/`。安装方开箱即用；维护者发版前必须先 `npm run build`，否则打包脚本会因入口缺失 / 版本陈旧拒绝出包。

## 八、排查时的硬性约束

- 不要在 skill 或 project 目录内创建临时文件（截图、JSON dump、日志、测试输出）。需要落盘时写入 `%TEMP%`，用完删除。
- 不要为了绕过门控去调用 `open_application` 之外的手段模拟输入（shell、脚本、其他自动化库）。
- 不要把 `COMPUTER_USE_ENABLED=0` 当作"修复"手段长期保留；它是紧急开关，会让整个 server 不可用。
