---
name: computer-use-windows
version: 0.5.5
description: Windows 桌面 computer-use 能力：截图（多显示器 / 混合 DPI / 区域放大）、鼠标点击与拖拽、键盘输入与组合键、应用启动与前台切换、剪贴板读写、窗口与显示器映射。自带独立 MCP server 与 Python runtime，首次运行自动自举，不依赖私有原生模块或提取的应用资产，适配任意支持 MCP 的 agent 客户端。当任务需要在 Windows 上操作用户桌面（截屏、点击、输入文字、按快捷键、启动或切换应用、读取剪贴板、多屏操作）时，使用本 skill。
agent_created: false
tags:
  - skill
  - windows
  - computer-use
  - automation
  - mcp
---

# Windows 电脑使用 Skill

## 零、坐标：全程只有一条规则

> **把截图图像上直接读到的像素原样传回，不做任何换算。** DPI、显示器缩放百分比、物理分辨率、截图降采样比例一律不参与坐标计算 —— server 已经把图像像素映射到屏幕了。
>
> **截图默认保持干净**（UI 开发、视觉审查、截图存证都需要原始像素）。只有在长会话里点小控件频繁点偏时，才由运行者设 `COMPUTER_USE_COORD_GRID=1` 叠一层淡坐标网格：顶部 / 左侧的标签数字**就是该传的图像像素坐标**，照着读即可，不需要任何推导。`zoom` 放大图始终不带网格（它不是坐标系）。
>
> 长任务里如果开始想"是不是要乘个系数"，答案永远是不乘。这类系数会互相矛盾（乘到物理像素是一个值、乘到逻辑点是另一个值），任何一次相乘都是二次换算，点击会随模型当时"相信"的比例来回漂。三处兜底：
>
> - **每个工具返回末尾都有一条 `[COORD FRAME]` 提醒**（出错时也有）。以它为准，不需要回想本文档或工具描述。
> - `pixels` 模式下没有先 `screenshot` 就发带坐标的动作会被直接拒绝；坐标超出最近一张截图图像范围也会被拒绝并说明原因。
> - 显示器名称里的分辨率 / 缩放数字只用来认屏幕，绝不用来算坐标。

## 本 skill 提供什么

一套完整的 Windows 桌面控制能力，以本地 MCP server 的形式暴露给 agent：截图、鼠标、键盘、应用 / 窗口 / 显示器映射、剪贴板。

- **仅支持 Windows**（`platform: win32`，后端是 Windows 专属实现）。
- **自带独立 runtime**：只使用公开依赖 `Node.js + Python + mss + Pillow + pyautogui + psutil + pywin32`，不依赖任何 agent 客户端的本机二进制、`.node` 模块或提取的应用资产。
- **可自举**：首次真正调用工具时自动创建 `project/.runtime/venv` 并安装 Python 依赖。
- **客户端无关**：MCP over stdio，任意支持 MCP 的 agent 客户端都能接。

## 何时使用

- 需要看到 Windows 桌面内容（整屏截图、局部放大查看小字）
- 需要模拟用户操作（点击、双击、右键、拖拽、滚动、长按、施加修饰键）
- 需要输入文字（含中文等 Unicode）或按快捷键
- 需要启动应用、切换前台窗口
- 需要读写剪贴板
- 需要跨多显示器、混合缩放的屏幕操作

不适用：Linux / macOS 桌面；需要向管理员权限窗口注入输入且 runtime 未提权的场景（见「平台限制」）。

## 一、准备 runtime

自带项目位于 `./project`（相对 skill 安装目录，例如 `~/.agents/skills/computer-use-windows/project`）。下文所有路径均相对 skill 根目录。

如果 skill **不含** `dist/`、`node_modules/`、`.runtime/`，必须先构建：

```bash
cd ./project
npm install
npm run build
```

前置条件：Node.js >= 20；系统内可用 `py -3` 或 `python`（用于创建 venv）；首次构建与自举需要联网。

Python 侧无需手动准备，也不会在构建期安装。

## 二、接通 MCP

```json
{
  "mcpServers": {
    "computer-use-windows": {
      "command": "node",
      "args": [
        "C:/Users/<user>/.agents/skills/computer-use-windows/project/dist/cli.js"
      ],
      "env": {
        "COMPUTER_USE_DEBUG": "0",
        "COMPUTER_USE_COORDINATE_MODE": "pixels"
      }
    }
  }
}
```

把 `args[0]` 换成实际的 `project/dist/cli.js` 绝对路径即可。常用环境变量：

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_ENABLED` | `0` 禁用 | 启用 | 全局开关；禁用时工具列表为空 |
| `COMPUTER_USE_COORDINATE_MODE` | `pixels` \| `normalized_0_100` | `pixels` | 坐标语义，见「坐标规则」 |
| `COMPUTER_USE_COORD_GRID` | `1` 开启 | 关闭 | 可选：全屏截图叠加淡坐标网格与像素标签。默认关闭以保持图像干净；`normalized_0_100` 模式始终不画 |
| `COMPUTER_USE_DEBUG` | `1` 开启 | 关闭 | 调试日志输出到 stderr（`[computer-use]` 前缀） |

所有环境变量都在 **server 进程启动时**从 MCP 配置的 `env` 注入，改配置后必须重启 server 才生效；`COMPUTER_USE_ENABLED` / `COMPUTER_USE_COORDINATE_MODE` 还会在模块加载时求值一次。文档里说的「每次截图重新读取」只是没有把值缓存成常量，读的仍是启动时那份副本，**不等于改配置免重启**。完整变量表（含子开关）见 `references/runtime.md`。

## 三、核心工作流

严格按此顺序推进，每一步的结果都决定下一步：

1. **`request_access`** —— 在任何其他工具之前必须调用。传入 `apps`（应用显示名或 bundle id，可一次传多个）与 `reason`（一句话说明任务）。**名字优先从工具描述里给出的本机候选清单里挑**（该清单既含已安装应用，也含当前有可见窗口的进程，包含 Store 应用），避免自己猜名字。返回 `granted` / `denied`；`denied` 中 `reason: not_installed` 表示名字没解析到应用，换名称或改用可执行文件路径重试。
2. **`screenshot`** —— 拿到当前画面。白名单为空时 `screenshot` 直接返回 `allowlist_empty` 错误。
3. **动作** —— 点击 / 输入 / 按键 / 滚动 / 拖拽。坐标一律基于最近一次 `screenshot` 的图像像素。
4. **回到第 2 步验证**，再决定下一个动作。

要点：

- **截图是坐标系的原点。** 没有先截图就发带坐标的动作会被直接拒绝并提示先 `screenshot` —— 不再有"按缩放比粗略换算"的兜底，那种兜底只会让模型误以为自己算过坐标是可行的。
- **一屏内可预测的连续操作合并成 `computer_batch`**，一次往返完成「点击输入框 → 输入文字 → 回车」这类序列，显著减少往返次数。批内任一动作失败会停止，返回 `completed` / `failed` / `remaining`。
- **看不清的细部用 `zoom`**，不要靠猜坐标。
- **前台应用必须已在白名单内**，否则输入类工具返回 `app_not_granted` / `tier_insufficient`，且不做任何操作。需要操作新应用时先补一次 `request_access`。
- 用 `list_granted_applications` 随时确认当前白名单与授权 flag。

## 四、工具速查

25 个工具（`teach_*` 系列在当前 CLI host 下不注册）。

| 工具 | 必需参数 | 可选参数 | 说明 |
| --- | --- | --- | --- |
| `request_access` | `apps[]`, `reason` | `clipboardRead`, `clipboardWrite`, `systemKeyCombos` | 申请会话白名单；其他工具的前置 |
| `screenshot` | — | `save_to_disk` | 截取当前目标显示器 |
| `zoom` | `region[x0,y0,x1,y1]` | `save_to_disk` | 对上一张全屏截图的局部高清放大，只读 |
| `left_click` | `coordinate[x,y]` | `text`(修饰键) | 左键单击 |
| `double_click` | `coordinate` | `text` | 左键双击 |
| `triple_click` | `coordinate` | `text` | 左键三击 |
| `right_click` | `coordinate` | `text` | 右键（需 full tier） |
| `middle_click` | `coordinate` | `text` | 中键 |
| `left_click_drag` | `coordinate`(终点) | `start_coordinate` | 拖拽；省略起点则从当前光标拖 |
| `mouse_move` | `coordinate` | — | 移动光标，可触发 hover |
| `scroll` | `coordinate`, `scroll_direction`, `scroll_amount` | — | 方向 up/down/left/right，刻度 0–100 |
| `type` | `text` | — | 向当前焦点输入文本，支持换行与中文 |
| `key` | `text` | `repeat`(1–100) | 按键或组合键，如 `ctrl+c`、`ctrl+shift+s` |
| `hold_key` | `text`, `duration` | — | 按住组合键，秒（0–100） |
| `left_mouse_down` | — | — | 按下左键并保持 |
| `left_mouse_up` | — | — | 释放左键 |
| `wait` | `duration` | — | 等待，秒（0–100） |
| `cursor_position` | — | — | 读取光标位置 |
| `open_application` | `app` | — | 启动或把应用带到前台；须已在白名单 |
| `switch_display` | `display` | — | 切换截图目标显示器，或传 `auto` 复位 |
| `list_granted_applications` | — | — | 查看白名单、授权 flag 与当前坐标模式 |
| `release_lock` | — | — | 任务结束时释放桌面会话锁，让并发的另一个 agent 会话接管；未持锁时幂等成功 |
| `read_clipboard` | — | — | 需 `clipboardRead` |
| `write_clipboard` | `text` | — | 需 `clipboardWrite` |
| `computer_batch` | `actions[]` | — | 单次调用执行动作序列 |

每个工具的完整参数说明与返回值结构见 `references/tools.md`。

### 按键命名

键名不区分大小写，组合键用 `+` 连接，例如 `enter`、`esc`、`tab`、`space`、`up`/`down`/`left`/`right`、`home`/`end`、`pageup`/`pagedown`、`f1`–`f12`、`delete`、`backspace`、`ctrl+shift+s`。

修饰键：`ctrl`、`alt`、`shift`、`win`。为兼容习惯写法，`cmd` / `command` / `meta` / `super` 会被映射为 `win`。在 Windows 上复制粘贴请用 `ctrl+c` / `ctrl+v`。

## 五、坐标规则

这是最容易出错的部分；唯一规则见本文开头的「零、坐标」。

- **坐标永远相对最近一次 `screenshot` 返回的图像**，而不是物理像素、也不是逻辑点。
- 截图会按视觉 token 预算等比缩小，图像尺寸通常小于显示器分辨率。**具体尺寸与比例属于运行者侧的实现细节**（见 `references/runtime.md`），模型侧既无需关心、也不得据此推导系数 —— 直接从图像上读像素，原样交给 server。运行者可用 `COMPUTER_USE_IMAGE_MAX_PX` / `COMPUTER_USE_IMAGE_MAX_TOKENS` 调整该预算。
- **长上下文防漂移**：每个工具返回末尾都带一条 `[COORD FRAME]` 提醒（含错误返回）；`pixels` 模式下坐标超出最近一张截图图像范围会被直接拒绝，错误文本会明确指出"图像边界不是换算系数"。越界检查只能拦住落在图像外的二次换算，落在图像内的仍以 `[COORD FRAME]` 规则为准 —— 所以那条提醒每轮都重复。
- **可选坐标刻度（默认关闭）**：需要精确定位时由运行者设 `COMPUTER_USE_COORD_GRID=1`，全屏截图会在视觉预算缩放后叠加淡网格（每 100px 一条线）与顶部 / 左侧像素标签（每 200px 一个），标签数字就是该传的图像像素坐标。绘制**不改变图像尺寸**，`ScreenshotResult.width/height` 与换算基准不变；`zoom` 放大图始终干净；像素陈旧校验的 fresh 图与 `save_to_disk` 落盘图走同一份 base64，开关状态一致。默认关闭是因为网格线会干扰对齐 / 间距判断、可能被误认成 UI 元素，也会进入作为证据的截图。
- `pixels` 模式（默认）：给出截图像素坐标。换算使用**截图时刻**记录的显示器几何，因此截图后改变显示器设置不会让点击错位。
- `normalized_0_100` 模式：给出相对目标显示器的百分比（0–100）。
- **`zoom` 的坐标基准不变**：放大图仅用于观察，后续点击仍以全屏截图为基准。
- `cursor_position` 返回的是相对最近一张截图的图像像素坐标（未截图时按逻辑点）。
- `left_mouse_down` / `left_mouse_up` 作用于当前光标位置，需先用 `mouse_move` 定位。

### 多显示器与 DPI

- 每块显示器会上报型号、分辨率、缩放比、相对主屏方位。运行时内部编号可能与你看到的 Windows 设置编号不一致，**按型号 / 分辨率 / 缩放 / 方位描述来识别**（"125% 的那块屏"、"右边那块"）。**这些数字只用于认屏幕，不参与任何坐标计算**；多屏提示文本与 `switch_display` 参数说明里也会重申这一点。
- 没有显式指定屏幕时，首次截图会自动落在**已授权应用窗口所在的那块屏**（若多个已授权应用分散在不同屏，解析结果取第一个）。所以不必先猜屏幕再截图。
- 当存在 2 块以上显示器时，`screenshot` 会附带一条文本说明本次截的是哪块屏，并列出其他屏幕名称；把该名称原样传给 `switch_display` 即可切换，切完必须重新截图。
- Store 应用（计算器、照片等）与普通桌面程序一样可以授权和操作：运行时会把 `ApplicationFrameWindow` 还原到真正的宿主进程，因此 `request_access` 的 `windowLocations` 里能看到它们在哪块屏。
- 混合 DPI（不同缩放比）场景已处理：Python 进程以 Per-Monitor v2 DPI awareness 启动，截图像素与点击目标一致。
- 鼠标坐标最终是虚拟桌面的绝对像素，由 server 自动加上该显示器的原点偏移。

## 六、权限与门控

`request_access` 建立会话白名单。所有输入类工具在执行前校验：

1. **白名单**：前台应用必须已授权，否则拒绝执行。
2. **Tier（授权档位）**：按应用类型自动决定 —— 浏览器 / 交易类为 `read`，终端 / IDE 为 `click`，其余为 `full`。
   - 移动光标：任意 tier
   - 普通点击、双击、三击、滚动、拖拽起点：需 `click` 或 `full`
   - 右键 / 中键 / 带修饰键的点击 / 拖拽终点：需 `full`
   - 键盘输入（`type` / `key` / `hold_key`）：需 `full`
3. **授权 flag**（默认全关，需在 `request_access` 里显式申请）：
   - `clipboardRead` / `clipboardWrite` —— 否则剪贴板工具报 `grant_flag_required`
   - `systemKeyCombos` —— 否则系统级组合键被拦截

当前 Windows 黑名单组合键：`ctrl+alt+delete`、`alt+f4`、`alt+tab`、`win+l`、`win+d`。其余组合键正常可用。

说明：自带 CLI host 使用自动批准实现（`project/src/session.ts`），因此 `request_access` 会直接返回 `granted`，不需要人工确认弹窗；若宿主客户端自带审批层，则以客户端为准。

**单会话独占**：同一时刻只允许一个 computer-use 会话操作桌面，锁文件位于 `~/.computer-use-windows/computer-use.lock`。被其他活动会话持有时，工具返回 `cu_lock_held`。判定"同一会话"的身份取自 `CODEX_THREAD_ID`，缺失时退化为 `pid-<pid>`。锁的三条释放路径：持有进程退出后自动回收；任务结束时主动调 `release_lock`（**推荐收尾动作**）；持有者持续闲置超过空闲阈值（`COMPUTER_USE_LOCK_IDLE_SECS`，默认 300 秒）后被其他会话接管。

## 七、平台限制

- **截图不做过滤**：runtime 上报 `screenshotFiltering: none`，屏幕上所有窗口都会出现在截图里。动作门控由 MCP 层承担，不是 compositor 原生能力。因此**不要把敏感内容暴露给不需要它的任务**。
- **不隐藏窗口**：动作前只会把已授权应用窗口置前，不会隐藏白名单外的窗口（与 macOS 实现不同）。若有非白名单窗口挡在目标上，需要显式切换前台。
- **控制台应用要授权宿主，不是 shell**：Windows 终端窗口归 `WindowsTerminal.exe`（旧式是 `conhost.exe`），授权 `powershell.exe` / `pwsh.exe` 之后仍然无法操作，门控会报 `"Windows Terminal Host" is not in the allowed applications` 并说明原因。此时按提示授权宿主可拿到 `click` 档控制，或者**改用自己的 shell 工具跑命令** —— 后者几乎总是更好的选择。
- **UIPI 提权边界**：目标窗口是管理员权限而 runtime 不是时，Windows 会拦截输入注入，helper 会显式报错并提示以管理员身份运行 runtime。截屏与窗口管理不受影响。
- **UAC 安全桌面**：切到安全桌面期间无法截屏或注入输入。
- **远程桌面 / 会话边界**：RDP 断开的会话中桌面不可操作。
- 应用自身的反自动化限制无法绕过：若目标明确拒绝自动化输入，应停止并告知用户，不要尝试用 `open_application`、命令行等方式绕过门控。

## 八、临时文件与硬性规则

- 仅将本机视为可信本地环境。
- 严禁在 skill 或 project 目录内创建临时文件（截图、解码图片、JSON dump、测试输出、日志）。需要写盘时一律写入系统临时目录（Windows：`%TEMP%`，即 `C:\Users\<用户>\AppData\Local\Temp`）。`project/.runtime/` 下只允许存在自举 venv 及其锁 / 配置数据（`venv/`、`requirements.sha256`）。任务结束后清理自己产生的临时文件。
- 截图默认通过 MCP image content 直接返回，**无需落盘**。需要把图交给用户看时，给 `screenshot` / `zoom` 传 `save_to_disk: true`：运行时会写入 `%TEMP%\computer-use-windows\`，并在结果文本里给出绝对路径。这些图是临时产物，用完请清理。
- 不要让用户去任何 agent 客户端的本地安装目录里寻找二进制或隐藏资产 —— 本 runtime 是独立的，只用公开依赖。
- 说明当前 runtime 上报 `screenshotFiltering: none`，动作门控在 MCP 层处理。

## 九、参考文件

- `references/tools.md` —— 25 个 MCP 工具的完整参数与返回结构、`computer_batch` 动作 schema、错误码表。
- `references/runtime.md` —— 全部环境变量、Python helper 子命令、venv 自举机制、目录结构与数据落点。
- `references/troubleshooting.md` —— 构建 / 自举 / 输入 / 多屏 / 提权等常见故障的定位与处置。
