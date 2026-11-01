# Windows 电脑使用 Skill 0.5.2

## 项目定位

这个项目完全本地化，同时是：

- 一个顶级 `skill`（入口见 `SKILL.md`）
- 一套独立的 Windows 桌面控制 runtime
- 一个给 agent 生态使用的 computer-use MCP server

它是 skill-first，客户端无关，可对接任意支持 MCP 的 agent 产品。

### 这个项目解决什么问题

- 不依赖任何特定 agent 客户端的本机应用
- 不依赖私有 `.node` 二进制
- 不依赖提取内部隐藏资产
- skill 装上、server 构建好，就能直接用

### 你现在拿到的能力

- 顶级 Windows computer-use skill
- 独立 MCP server：截图、鼠标、键盘、应用启动、窗口/显示器映射、剪贴板
- 只使用公开依赖：`Node.js + Python + pyautogui + mss + Pillow + psutil + pywin32`
- 首次运行自动自举：自动创建虚拟环境并安装 Python 依赖
- 提取出来的 TypeScript 工具层已经接到 Windows 原生 Python backend

## MCP 配置

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

## 暴露的 MCP 工具

共 25 个（`teach_*` 系列在当前 CLI host 下不注册）：

| 分类 | 工具 |
| --- | --- |
| 会话与权限 | `request_access`、`list_granted_applications`、`release_lock` |
| 截图 | `screenshot`、`zoom` |
| 鼠标 | `left_click`、`double_click`、`triple_click`、`right_click`、`middle_click`、`left_click_drag`、`mouse_move`、`scroll`、`left_mouse_down`、`left_mouse_up`、`cursor_position` |
| 键盘 | `type`、`key`、`hold_key` |
| 应用与窗口 | `open_application`、`switch_display`、`wait` |
| 剪贴板 | `read_clipboard`、`write_clipboard` |
| 批处理 | `computer_batch` |

完整参数说明见 `references/tools.md`。

## Windows 实机验证结果

以下已在真实 Windows 机器上端到端验证通过：

- TypeScript 构建（`npm run build`）与类型检查（`npm run check`）
- Python venv 自举链路（首次运行自动创建 `.runtime/venv` 并安装依赖）
- Python helper 只读能力实测：权限检查、显示器枚举（2560x1600 x3）、截图采集（内容正确）、前台应用识别、光标位置、应用枚举
- MCP stdio 握手、`tools/list`、权限门控（未授权时截图被正确拒绝并提示先调 `request_access`）
- 实操链路：窗口激活、`left_click` 点击落点（150% DPI 缩放下坐标换算正确）、键盘组合键、Unicode 文本输入（空格/中文/全角标点完整）
- UAC / 管理员窗口：提权窗口可正确识别、截图与窗口管理正常；非提权 runtime 注入的输入被 Windows UIPI 拦截，helper 会显式报错并提示以管理员运行 runtime
- 混合 DPI 场景，多屏不同缩放验证通过

## 打包分发

```bash
python scripts/validate_skill.py .   # 先校验 skill 结构
cd scripts
python package_skill.py              # 生成 computer-use-windows.zip
```

打包的是纯净的 skill 目录结构，不含构建产物和无关文件

## 项目结构

```text
SKILL.md               # 技能入口指引（agent 先读这个）
README.md              # 本文件
references/
  tools.md             # 24 个 MCP 工具的完整参数与错误码
  runtime.md           # 环境变量、helper 子命令、自举机制、分层说明
  troubleshooting.md   # 常见故障定位与处置
project/
  src/
    computer-use/      # Windows 适配层（executor / gates / pythonBridge / imageSave / 锁）
    vendor/computer-use-mcp/  # 平台无关的 MCP 工具与门控框架
  runtime/             # Windows Python helper 与依赖清单
  dist/                # 构建产物（不随 zip 分发）
  .runtime/            # 自举 venv 与依赖 stamp（不随 zip 分发）
scripts/
  package_skill.py     # 打包分发脚本
  validate_skill.py    # skill 结构校验（UTF-8 安全，无第三方依赖）
```

## 架构

```mermaid
flowchart LR
    A["Agent / MCP Client"] --> B["computer-use-windows"]
    B --> C["TS MCP 工具层 · vendor/computer-use-mcp"]
    B --> D["Windows 适配层 · computer-use"]
    C --> D
    D --> E["Python bridge · 自举 + 调用"]
    E --> F["windows_helper.py"]
    F --> G["pyautogui"]
    F --> H["mss + Pillow"]
    F --> I["psutil + pywin32"]
    G --> J["鼠标 / 键盘"]
    H --> K["截图"]
    I --> L["应用 / 窗口 / 显示器 / 剪贴板"]
```

分层细节见 `references/runtime.md`。

## 运行说明

### 环境变量

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `COMPUTER_USE_ENABLED` | `0` 禁用 | 启用 | 全局开关；禁用时工具列表为空 |
| `COMPUTER_USE_COORDINATE_MODE` | `pixels` \| `normalized_0_100` | `pixels` | 坐标语义 |
| `COMPUTER_USE_DEBUG` | `1` 开启 | 关闭 | 调试日志输出到 stderr |
| `COMPUTER_USE_LOCK_IDLE_SECS` | 非负整数 | `300` | 会话锁空闲接管阈值（秒）；持有者闲置超过该时长后其他会话可接管，`0` 禁用接管 |

前两项在进程启动时读取一次，改动后需重启 server。完整变量表（含子开关）见 `references/runtime.md`。

### 权限

Windows 不像 macOS 那样需要 Accessibility / Screen Recording 授权弹窗，但仍可能受这些因素限制：

- agent 进程不是管理员，而目标窗口是管理员权限（UIPI 会拦截输入注入，helper 会显式报错）
- UAC 安全桌面切换
- 会话 / 远程桌面边界
- 应用自身的反自动化限制

此外，桌面同一时刻只允许一个 computer-use 会话操作，锁文件位于 `~/.computer-use-windows/computer-use.lock`。锁的释放有三条路：持有进程退出后自动回收；agent 任务结束时主动调 `release_lock`；持有者进程还活着但持续闲置（心跳超过 `COMPUTER_USE_LOCK_IDLE_SECS`，默认 300 秒）时被其他会话接管 —— 两个 IDE 常驻、其中一个不再使用 desktop 的场景不会再永久占锁。生命周期细节见 `references/runtime.md`「会话锁」。

### 会话模型

所有输入类工具都受会话白名单约束：必须先 `request_access` 授权应用，工具才会执行；未被授权的应用返回错误且不做任何操作。白名单还带授权档位（browser/trading → `read`，terminal/IDE → `click`，其余 → `full`）与可选 flag（`clipboardRead`、`clipboardWrite`、`systemKeyCombos`）。自带 CLI host 使用自动批准实现，无人工弹窗。

### 截图过滤

当前 runtime 声明的是 `screenshotFiltering: none`。

也就是说，截图过滤不是 compositor 原生级别，屏幕上所有窗口都会出现在截图里，动作 gating 仍由 MCP 层处理。与 macOS 实现不同，Windows 的动作前准备**不会隐藏**白名单外的窗口，只会把已授权应用置前。

### 平台范围

当前项目明确是 `Windows-only`。

覆盖能力：

- 截图（含区域放大、多显示器、混合 DPI）
- 鼠标控制（点击 / 拖拽 / 滚动 / 按下释放）
- 键盘输入（Unicode 文本、组合键、长按）
- 前台应用识别
- 已安装 / 运行中应用发现
- 窗口到显示器映射
- 剪贴板访问
- 应用启动

### 已知限制

- `request_access` 的候选应用清单是「注册表安装项 ∪ 当前有可见窗口的进程」，上限 50 个（超出会附 `... and N more`）。少数条目仍是不易读的文件名（如 `mspaint`、`store`、`devenv`），因为对应可执行文件没有版本资源可读。
- `resolvePrepareCapture` 的 `focusBeforeAction` 选项沿用 macOS 实现，helper 忽略它；`autoResolve` 已实现（按已授权应用窗口所在屏选显示器）。
- `check_permissions` 在 Windows 上恒返回已授权，因此 `tcc_not_granted` 分支不会触发。
- 截图分辨率由消费方模型的输入预算决定（长边 1568px，且 `ceil(w/28)×ceil(h/28) ≤ 1568`）。2560x1600 的屏实际得到 1389x868，因此小字号文本要配合 `zoom` 阅读。可用 `COMPUTER_USE_IMAGE_MAX_PX` / `COMPUTER_USE_IMAGE_MAX_TOKENS` 调整，但请先读 [0.4.0：图像预算可配置](#0.4.0：图像预算可配置) 一节的前提说明。

## 更新日志

### 0.5.2：注册表路径展开、抢焦点不再抛异常、`open_application` 的名字与控制台窗口

0.5.1 发布后拿一个 XCGUI 自绘应用做回归，撞出一串既有缺陷，全部修掉。共同特征是「工具说成功、实际什么都没发生」或者反过来。

- **注册表路径先展开环境变量**（`expand_registry_path`）。PowerShell 的 App Paths 默认值是 `%systemroot%\system32\...`，而授权比对用的是进程镜像路径（永远是全展开的），于是这条 bundleId 匹配不上任何运行中的进程：应用显示为已授权却完全不可操作，`focus_existing_window` 找不到窗口，`prepare_for_action` 还会转而去聚焦别的应用。顺带 `file_description` 才第一次读得动，显示名从退化的 `PowerShell` 变成真实的「Windows PowerShell」。
- **`_force_foreground` 返回 bool 且不再抛异常**。原先只有第一次 `SetForegroundWindow` 有兜底，`AttachThreadInput` 之后的第二次没有 —— 而后台进程抢不到前台是常态，于是每个输入动作都可能把原始 pywin32 元组甩给模型：`Tool "left_click" failed: (0, 'SetForegroundWindow', ...)`。现在 `prepare_for_action` 忽略结果（紧随其后的前台门控会重读真实前台并报出正确的 `app_not_granted`），`focus_existing_window` 透传结果，让 `open_application` 能为「已置前」说真话。
- **`open_application` 的名字解析与 `request_access` 对齐**。旧实现要求显示名精确相等，而 `request_access` 是宽松解析的：授权 `Notepad++` 记成 `Notepad++ (64-bit x64)` 之后，`open_application("Notepad++")` 被拒，错误还说「call request_access first」，把模型推进重新授权的循环。现在是 bundleId → 精确 → 松匹配（显示名互为子串或等于可执行文件名）→ **多命中拒绝猜测**（`bad_args` 列出候选）→ 无命中列出已授权名字。
- **控制台应用**：窗口归 `WindowsTerminal.exe`，shell 不在其子树里（宿主父进程是 `svchost`），没有可靠的窗口→shell 映射，猜错就是把输入送进另一个可能已提权的 shell —— 所以不做 `resolve_window_pid` 那种穿透，改由 `consoleHostNote()` 在前台门控与落点校验处说清情况；同时 `open_application` 匹配不到窗口时改为聚焦宿主窗口，不再每次新开一个 tab。
- **`open_app` 的两条 `Popen` 兜底 `DEVNULL` 掉 stdio**。bridge 用 `execFile`，resolve 时机是所有 stdio 流 EOF 而非 helper 退出；被启动的程序继承 stdout 句柄会让工具一直挂到客户端超时（`-32603 did not complete`），而应用其实已经打开。`os.startfile` 不下传句柄，所以只有兜底分支会中招 —— 也正是第一条那个未展开路径逼出来的。

实测：`scroll` 四方向（down/up 幅度线性、left/right 借关闭自动换行的 Notepad++ 确认行首滚出与滑块位移）；`allowlist_empty`、两处 `app_not_granted`（含控制台宿主专门文案）、`tier_insufficient`、`cu_lock_held` 全部实机触发并核对文本；`open_application` 的精确 / 松匹配 / 歧义 / 无命中四条分支各自跑通；控制台应用连续两次 `open_application` 后进程与窗口数不变（修复前每次多一个）。`npm run build` / `check` 与 `validate_skill.py` 通过。

### 0.5.1：修好 `scroll` 的滚轮量，并让门控错误自己指路

**`scroll` 此前对自绘控件完全无效。** 症状是「工具返回 `Scrolled.`，页面纹丝不动」。根因不在 Windows 的滚轮投递方式，而在注入量：helper 走 `pyautogui.scroll()`，而它的 win32 实现把「格数」原样塞进 `mouse_event` 的 `dwData`，**从不乘 `WHEEL_DELTA(120)`** —— `scroll_amount: 3` 实际发出 delta=3，即 1/40 格。自绘控件（XCGUI / DirectUI）按 `delta / 120` 取整算行数，直接归零；浏览器会把小数 deltaY 累加掉，所以这条路径在浏览器里「看起来是好的」，一直掩盖着它。此外 pyautogui 的符号约定与 executor 的屏幕坐标 `dy` 相反（正数 = 向上滚），且它 `except (PermissionError, OSError): pass` 吞掉注入错误 —— 永远不会报错，只会静默无效。现在两个轴都自己乘 120、纵向按 `dy` 取负。

实测（XCGUI demo，同一落点，窗口区域像素差分 + 「只移光标不滚」对照组）：delta ±3 / ±30 → 0.00%；-120 → 15.83%；-360 → 14.75%。修复后 up / down 端到端复测通过。`PostMessage(WM_MOUSEWHEEL)` 同样能滚，但并不需要它 —— 硬件式注入本来就够，问题从来是量不够。

**门控错误与握手文案现在会把 agent 带到正确的下一步。** 不少客户端里的 agent 不加载 skill 就直接调 MCP 工具，第一个动作往往是 `screenshot`，必然失败；而原来的错误只说「不允许」，读起来像工具坏了。现在四层各就各位，分工记录在 `references/tools.md`「门控错误文案」：

- MCP `initialize` 新增 `instructions` —— 唯一前置到首次调用之前的文案位，写明 `request_access → screenshot → act` 的固定顺序。
- `ACCESS_GATE_GUIDANCE` 拼在 `allowlist_empty` 与两处 `app_not_granted` 尾部：给出可直接照做的 `request_access` 形状，并点名一个高频成因 —— 授权记的是 exe 路径，应用重新构建换目录（`go run` 每次换 `go-build<hash>` 临时目录）、重装、便携应用被移动之后，已授权应用会重新变成「不在白名单」。
- `TIER_ANTI_SUBVERSION` 改为跨平台措辞，并补上原先只点名 macOS 工具时留着的那扇门：直接命令行调用 `windows_helper.py` 的子命令可以绕开全部门控。
- `cu_lock_held` 的三个出口统一拼上 `LOCK_HELD_GUIDANCE`，澄清 `release_lock` 只能释放本会话的锁；空闲接管的具体秒数改由 host 按 `COMPUTER_USE_LOCK_IDLE_SECS` 实际值生成，`=0` 时不再给出根本不存在的接管承诺。

顺带：落点校验的文案不再写死 `Click at these coordinates`（`scroll` 与拖拽同样走这条路径）；`SKILL.md` frontmatter 的版本号从 0.4.2 补齐（0.5.0 发布时漏了这一处）。

实测：`npm run build` 与 `npm run check` 通过；`instructions` 经真实 stdio 握手确认已下发；两条 `cu_lock_held` 组合文案（默认 300 秒 / `COMPUTER_USE_LOCK_IDLE_SECS=0`）走代码路径渲染核对，确认 host 与 vendor 两半不重复、不矛盾。

### 0.5.0：会话锁可释放了（心跳空闲接管 + `release_lock`）

v0.4.x 的锁一旦获取就持有到 server 进程退出：两个 IDE 同时开着，先做过一次 desktop 操作的那个会永久占锁，另一个永远拿到 `cu_lock_held` —— 即使它早就不再使用桌面。本次两项改进，互补：

- **心跳 + 空闲接管**：锁文件新增 `lastHeartbeat` 字段，本会话每次经过锁门控都刷新（`touchComputerUseLock`）。持有者进程还活着但心跳超过 `COMPUTER_USE_LOCK_IDLE_SECS`（默认 300 秒，`0` 禁用）时，其他会话的 check/acquire 将其视为 stale 回收并接管。活跃会话的每次工具调用都在刷新心跳，不会中途被抢 —— 粘住的只是真正闲置的会话。
- **`release_lock` 工具**（第 25 个工具）：agent 任务结束时主动放锁，不等空闲兜底。幂等：未持锁时返回「nothing to release」而非错误；锁被其他会话持有时照常在门控处报 `cu_lock_held`。释放后需要桌面时直接调动作工具即可自动重新获取。

兼容性：pre-0.5.0 的锁文件没有心跳字段，视为「无闲置证据」，不会被接管（避免抢活蹦乱跳的旧版本会话），进程退出回收照旧。锁的获取时机不变（首个动作工具，`request_access` 等仍是 defer）。

实测：锁语义 11 项断言（获取 / 自见 / 阻塞 / 空闲接管 / 被抢后原持有者阻塞 / 释放 / 幂等 / 旧锁不接管）+ MCP stdio 全链路 11 项（25 工具注册、截图持锁、release 删文件、幂等、再获取）全部通过。

### 0.2.0：补齐 save_to_disk 与鼠标缓动，清理死代码

- `COMPUTER_USE_HIDE_BEFORE_ACTION` 更名为 `COMPUTER_USE_FOCUS_BEFORE_ACTION`（Windows 侧从不隐藏窗口）。
- 实现 `COMPUTER_USE_MOUSE_ANIMATION` 指针缓动：按距离计算 pyautogui 时长（2000 px/秒，上限 0.5 秒），每次动作前重新读取门控，中途改动即时生效。
- `save_to_disk: true` 现在真的写盘：输出到 `%TEMP%\computer-use-windows\` 并在结果里返回绝对路径。
- `list_granted_applications` 的返回值新增 `coordinateMode`，与工具描述一致。
- 删除了 `inputLoader.ts` / `swiftLoader.ts` / `escHotkey.ts` / `drainRunLoop.ts` 四个遗留占位模块（调用即抛错，本 runtime 从未使用）。

### 0.2.1：实机验证中修掉的缺陷

以下五项都是在一台 3 屏 2560x1600 @150% 的真机上跑 MCP 全链路时暴露并修复的：

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| helper 输出编码 | 显示器标签的 `·`、中文应用名、剪贴板内容变成 U+FFFD（Python 按 cp936 写管道） | 调用侧 `PYTHONIOENCODING=utf-8` + helper 自行 `reconfigure` |
| 剪贴板崩溃 | `read_clipboard` 报 access violation（x64 HANDLE 被截断成 32 位） | 为剪贴板 / 句柄 API 声明 `argtypes` / `restype` |
| Store 应用无法驱动 | 计算器能授权却打不开、点不到（窗口归 `ApplicationFrameHost.exe`） | 新增 `resolve_window_pid`，穿透 `ApplicationFrameWindow` 找到宿主进程 |
| 自动定位显示器空转 | 已授权应用在第 2/3 屏，首张截图却总在主屏 | helper 的 `resolve_prepare_capture` 支持 `autoResolve` + `allowlistBundleIds` |
| `type` 极慢 | 27 字符耗时 7.1 秒（每个字素启动一次 Python 进程） | 连续普通字符合并为一次调用，同字符串降到 1.1 秒 |
| `open_application` 重复开窗 | 契约是「带到前台」，实际每次调用都新开一个窗口（验证期间攒出 3 个记事本窗口） | 先按宿主进程匹配已有窗口并聚焦，找不到才启动 |

### 0.3.0：补齐应用枚举

`request_access` 的候选清单此前只来自注册表，导致模型看不到 Store 应用（计算器就在屏上却拿不到名字），同时混入大量内部代号（`olk`、`msoasb`、`IEDIAGCMD`）。两项改动：

- **显示名改取可执行文件的版本资源**（仅 `App Paths` 分支）：`olk` → `Microsoft Outlook`、`chrome` → `Google Chrome`、`EXCEL` → `Microsoft Excel`。Uninstall 分支不动 —— 它的 `DisplayName` 已是本地化的用户可见名称（`剪映专业版`、`阿里云盘`），用版本资源覆盖反而更差（→ `JianyingPro`、`aDrive`）。
- **并入「当前有可见窗口的进程」**（新增 helper 命令 `list_window_apps`）：可见窗口是「这是用户能指认的应用」的最强信号，Store 应用由此进入清单。窗口来源的条目跳过安装路径白名单，否则 `D:\apps\`、`C:\apps\` 下的便携应用会被丢掉。

实测：清单中出现 `Calculator`；抽样的 `Calculator`、`Notepad`、`Google Chrome`、`MuMu模拟器` 四个名称全部授权成功（中文名亦正常）。

### 0.3.1：不再放大截图

截图目标尺寸此前会乘显示器缩放系数 —— 又是 macOS 移植残留（那边 `DisplayGeometry` 是逻辑点，需要乘才能得到物理像素）。本后端上报的已是物理像素，乘上去只会把图放大：1280x800 的屏会被插值成 1389x868，像素更多、载荷更大、细节为零。分辨率足够大的屏受 token 预算限制，乘与不乘结果相同，因此这个偏差一直没暴露。`zoom` 的放大属刻意行为，保留（改用独立的 `zoomTargetDims`）。

### 0.4.0：图像预算可配置

先解释清楚它到底是什么：

视觉模型不把整张图当一个输入，而是切成 **28×28 像素的 tile**，每个 tile 花 1 个 token。所以一张图的代价是 `ceil(w/28) × ceil(h/28)`。本 runtime 用两个上限（长边 1568px、总 tile 数 1568）预先缩放截图，于是每张截图的代价被钉在约 1550 tokens，与显示器多大无关。2560x1600 的屏按原尺寸送是 5336 tokens（3.4 倍），缩到 1389x868 后才达标。

**为什么必须本地先缩**：这两个数不是本 runtime 的偏好，而是移植自消费方模型自己的图像转码器。预先缩到"消费方不会再动"的尺寸，才能保证 `ScreenshotResult.width/height` 等于模型真正看到的图 —— `scaleCoord` 靠这个比例换算点击坐标。如果本地按 1389 算、而消费方又缩到别的尺寸，点击就会按错误比例偏移（1568 与 1389 之差约 13%）。

**新增开关**：

| 变量 | 取值 | 默认 |
| --- | --- | --- |
| `COMPUTER_USE_IMAGE_MAX_PX` | 正整数，或 `native` | 1568 |
| `COMPUTER_USE_IMAGE_MAX_TOKENS` | 正整数，或 `native` | 1568 |

`native` 表示不做预处理、直接发原始截图。**仅在消费方模型确实接受更大的图时才有意义**（本地 VLM，或 tiling 参数不同的服务）；否则图会在到达时被重新缩放，模型按更大的图读数取坐标，而我们报告的尺寸更小，点击反而更不准 —— 覆盖默认值时启动会打印一条 warn 提示这点。调高预算建议同时用 `COMPUTER_USE_COORDINATE_MODE=normalized_0_100`：百分比坐标的换算不依赖图像像素尺寸，不受下游重缩影响。

想"看清细节"请优先用 `zoom`：它把区域裁出来再放大，预算作用在那一小块上，同一屏幕面积的有效像素远高于整屏截图。

### 0.4.1：缓动默认关闭、补文档

- **`COMPUTER_USE_MOUSE_ANIMATION` 改为默认关闭**（显式 `=1` 才开启）。缓动对普通点击没有价值，只对少数需要"真实指针轨迹"的软件有用（悬停才展开的菜单、监听移动的拖放目标），代价是每次点击最多多等约 0.5 秒。
- 文档新增**落点校验（hit-test）**一节：所有鼠标落点类工具在注入输入前会检查目标坐标下的应用，不在白名单或档位不足都会拒绝执行。
- 修掉架构图在 Typora 里的 `Lexical error`：mermaid 10.1.0 的词法分析器不接受**未加引号的 `·`**，节点标签一律加引号即可（`/`、`-`、`+`、中文各自都没问题，是 `·` 触发的）。

### 0.4.2：权限检查不再每次工具调用都问一遍

vendored 框架的 Gate 2 会在**每次工具调用**前查询 OS 权限。macOS 上这是真的 TCC 检查；Windows 上没有 TCC 可问，helper 返回常量 `{accessibility: true, screenRecording: true}` —— 但这一次"询问"是一个完整的 Python 进程：

```
check_permissions 实测 5 次: 246 / 221 / 220 / 238 / 221 ms   → 均值 229ms
一次 wait 工具调用: 294ms  ← 几乎全部花在这个检查上
```

于是把它**记忆化为每进程一次**，每次工具调用省下约 230ms（约 20% 延迟；`left_click` 实测 1475ms → 1240ms）。失败不缓存，瞬时进程错误不会把会话永久钉在"权限缺失"状态。

同时清理了这个不可达分支上的谎话：报错原文是 `"Windows Accessibility and Screen Recording are now both granted."` —— macOS 词汇前直接拼了平台名，而 Windows 上既没有这两个权限，也没有那个面板。现在改为平台中立措辞（`input control` / `screen capture`），并在 Gate 2、`tcc_not_granted`、`tccState` 三处标注"Windows 上不可达"。

分支**没有删除**，因为它是"平台前置条件"的正确接缝 —— Windows 上真实存在的是另一组问题：**会话 0 / 无交互桌面、RDP 断开、UAC 安全桌面**。代码里写明了：若把这些接进来，必须同时移除记忆化（那些状态会在运行期间变化）。
