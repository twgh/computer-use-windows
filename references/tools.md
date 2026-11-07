# MCP 工具参考

> 文中 `project/src/...` 是**仓库源码路径**，只用于说明实现位置；分发包不含源码，运行时只有 `project/dist/cli.js`。

本文件是 `SKILL.md` 的深度参考。工具 schema 定义于 `project/src/vendor/computer-use-mcp/tools.ts`，分发与门控逻辑在 `project/src/vendor/computer-use-mcp/toolCalls.ts`。

共 25 个工具。`teach_step` / `teach_batch` / `request_teach_access` 仅在 capabilities 带 `teachMode` 时注册，当前 CLI host（`project/src/computer-use/common.ts`）未开启，因此不可用。

## 通用约定

- 坐标一律是 `[x, y]` 两元素数组，语义见 `SKILL.md` 开头的「零、坐标」与「坐标规则」：图像像素原样传回，禁止任何 DPI / 分辨率 / 降采样换算。
- **每个工具返回（含 `isError`）都额外附带一条独立的 `[COORD FRAME]` 文本块**，重复同一条坐标规则。它是长会话中的权威提示：模型不必回想文档，看最近一次工具结果即可。`computer_batch` 内部子动作不重复附带，只在整批结果末尾出现一次。
- 成功结果为文本；结构化结果以单行 JSON 文本返回（如 `request_access`、`list_granted_applications`、`computer_batch`）。`[COORD FRAME]` 是独立的追加文本块，不会破坏单行 JSON 的解析，也不会改变 `content[0]`。
- 失败结果带 `isError: true` 与 `telemetry.error_kind`（`telemetry` 在返回 SDK 前被剥离，客户端看不到）。错误文本已分类，不含文件路径等敏感内容。
- `screenshot` / `zoom` 的 `save_to_disk: true` 会把 JPEG 写入 `%TEMP%\computer-use-windows\`，并在结果里多返回一条文本给出绝对路径。保存失败不会吞掉图像：错误信息与图像一起返回。
- 除 `request_access` / `list_granted_applications` 外，所有工具都受白名单与 tier 门控（见 `SKILL.md`「权限与门控」）。
- 服务器在 MCP `initialize` 响应里带 `instructions`（`mcpServer.ts` 的 `SERVER_INSTRUCTIONS`），把「先 `request_access` → 再 `screenshot` → 再动作」的固定顺序前置到模型第一次调用之前，并指向本 skill。是否把它喂给模型由客户端决定，因此冷启动错误文本自身也要能指路（见下文错误码表）。

## 会话与访问控制

### `request_access`

在调用任何其他工具之前必须调用。用于申请操作一组应用的权限。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `apps` | `string[]` | 是 | 应用显示名（如 `"记事本"`）或 bundle id。显示名按大小写不敏感匹配已安装应用与运行中进程。工具描述里会列出本机候选名称（注册表安装项 ∪ 当前有可见窗口的进程，含 Store 应用），**优先从该清单里挑名字** |
| `reason` | `string` | 是 | 一句话说明任务（说明做什么，而不是怎么做） |
| `clipboardRead` | `boolean` | 否 | 一并申请读取剪贴板 |
| `clipboardWrite` | `boolean` | 否 | 一并申请写入剪贴板；授权后多行 `type` 会走剪贴板快路径 |
| `systemKeyCombos` | `boolean` | 否 | 一并申请发送系统级组合键（退出应用、切换应用、锁屏） |

返回 JSON：

```json
{
  "granted": [{ "bundleId": "...", "displayName": "...", "tier": "full" }],
  "denied": [{ "bundleId": "请求时的名字", "reason": "not_installed" }],
  "screenshotFiltering": "none",
  "windowLocations": [{ "bundleId": "...", "displayIds": [1] }]
}
```

- `windowLocations` 列出每个已授权应用窗口所在的显示器；Store 应用也会正确出现（运行时会把窗口还原到真正的宿主进程），可用它决定先 `switch_display` 到哪块屏。
- 中途可以再次调用以追加应用；已授权的应用保持授权且不会重复出现在 `granted` 中。
- `denied` 里 `reason: not_installed` 表示名字没解析到已安装应用 —— 换显示名或 bundle id 重试。
- 走的是「先整体解析、再按优先级剔除」的流程（策略拒绝 > 用户拒绝 > tier），被剔除的应用不会进入授权。
- 该工具**不触发**桌面会话锁的获取，首个实际动作工具才会持锁。

### `list_granted_applications`

无参数。返回当前会话白名单、授权 flag 与坐标模式：

```json
{
  "allowedApps": [...],
  "grantFlags": { "clipboardRead": false, "clipboardWrite": false, "systemKeyCombos": false },
  "coordinateMode": "pixels"
}
```

### `release_lock`

无参数。主动放弃本会话持有的桌面会话锁，让并发运行的另一个 agent 会话（如另一个 IDE 的 server 实例）可以接管桌面。两个场景调用：

- 任务结束时主动调用 —— 这是正确的收尾姿势，不要等空闲接管兜底；
- 报错 `cu_lock_held` 且提示符是本会话历史行为导致时，先释放再重试。

行为：

- 本会话持锁 → 释放并返回确认文本；锁文件随之删除。
- 本会话未持锁 → 幂等成功，返回「nothing to release」，模型无需重试。
- 锁被**其他**会话持有 → 在门控处返回 `cu_lock_held` 错误（释放别人的锁既不可能也无意义）。
- 释放后如需继续操作桌面，直接调用任意动作工具即可 —— 锁空闲时会自动重新获取。
- 该工具只检查锁、从不获取锁（与 `request_access` 同属 defer 集合）。

## 截图

### `screenshot`

截取当前目标显示器。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `save_to_disk` | `boolean` | 否 | 写入 `%TEMP%\computer-use-windows\` 并在结果文本里返回绝对路径 |

- 白名单为空时返回错误 `allowlist_empty`，不会返回图像。
- 返回内容为一段可选文本 + JPEG 图像。文本仅在条件满足时出现：显示器 ≥ 2 块且（首次截图或目标显示器发生变化）时，说明本次截图所在显示器并列出其他显示器；若上次截图后有小动作被隐藏的窗口，会提示原因。
- 返回的图像就是后续所有点击坐标的参照系。
- **默认返回干净图像**（适合 UI 开发 / 视觉审查 / 截图存证）。运行者设 `COMPUTER_USE_COORD_GRID=1` 时，全屏截图会叠一层淡坐标网格，顶部 / 左侧标签数字即图像像素坐标，**照抄标签即可得到 `coordinate` 参数**，无需任何换算。网格在缩放后绘制、不改变图像尺寸；`zoom` 放大图与 `normalized_0_100` 模式始终不带网格。`save_to_disk` 保存的是同一份图，开关状态一致。

### `zoom`

对**上一张全屏截图**的某个区域做高分辨率放大，用于读小字、按钮标签等细节。只读，不改变坐标系。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `region` | `[x0, y0, x1, y1]` | 是 | 矩形区域，坐标空间与最近一次全屏截图一致；`(x0,y0)` 左上、`(x1,y1)` 右下 |
| `save_to_disk` | `boolean` | 否 | 同上，写入 `%TEMP%\computer-use-windows\` 并返回路径 |

后续点击坐标**仍然**相对全屏截图，而不是放大图。

## 鼠标

以下工具的 `coordinate` 均为必需（除 `left_mouse_down` / `left_mouse_up`）；`text` 为可选修饰键（沿用 `key` 的语法，如 `"shift"`、`"ctrl+shift"`）。

| 工具 | `text` 支持 | tier 要求 |
| --- | --- | --- |
| `left_click` | 是 | `click` 或 `full` |
| `double_click` | 是 | `click` 或 `full` |
| `triple_click` | 是 | `click` 或 `full` |
| `right_click` | 是 | `full` |
| `middle_click` | 是 | `full` |
| `mouse_move` | 无该参数 | 任意（含 `read`） |

- `mouse_move`：移动光标但不点击，可用于触发 hover 状态。
- `left_click_drag`：必需 `coordinate`（终点），可选 `start_coordinate`（起点）。省略起点时从当前光标位置开始拖。终点要求 `full` tier。
- `scroll`：必需 `coordinate`、`scroll_direction`（`up` / `down` / `left` / `right`）、`scroll_amount`（整数 0–100，即滚动刻度数）。
- `left_mouse_down` / `left_mouse_up`：无参数，作用于当前光标位置。先 `mouse_move` 定位。`left_mouse_down` 在按键已处于按下状态时返回 `state_conflict`；`left_mouse_up` 在未按下时调用是安全的。
- `cursor_position`：无参数。返回相对最近一张截图的图像像素坐标（尚未截图时按逻辑点返回）。

### 坐标帧校验（先于一切鼠标动作）

`dispatchAction`（`toolCalls.ts`）是所有独立动作与 `computer_batch` 内子动作的共用入口，在触碰任何鼠标能力之前先校验坐标帧：

- `pixels` 模式没有上一张 `screenshot` → 直接拒绝，错误文本要求先截图。不再有"按 `scaleFactor` 粗略换算"的兜底。
- 坐标超出最近一张截图图像范围 → 拒绝（`bad_args`），并说明图像边界不是换算系数、通常是二次换算造成的。
- `normalized_0_100` 模式坐标超出 0–100 → 拒绝。

这层只拦明显越界的坐标；乘了较小系数后仍落在图内的二次换算，靠每个结果里的 `[COORD FRAME]` 提醒拦截。

### 落点校验（hit-test）

**所有鼠标落点类工具在注入输入之前都会检查目标坐标下是哪个应用**（5 种点击、`scroll`、`left_click_drag` 的起点与终点、`mouse_move`、`left_mouse_down` / `left_mouse_up`）。整体顺序是：坐标帧校验 → 坐标换算 → 落点校验 → 真正注入。

1. 目标应用**不在白名单** → 拒绝执行，返回 `app_not_granted`：

   ```
   Input at these coordinates would land on "Windows 资源管理器", which is not in the allowed applications. Take a fresh screenshot to see the current window layout. To make an app controllable, call request_access with its display name in `apps` and a one-sentence task in `reason` — ...
   ```

2. 目标应用在白名单但档位不够 → 拒绝执行，返回 `tier_insufficient`（例如右键点在一个 `click` 档应用上：右键菜单可以"粘贴"，等同键盘注入，所以需要 `full`）。
3. 目标应用是 `click` 档且剪贴板看护开启 → **点击前**先暂存并清空剪贴板，堵住"点非前台 click 档窗口的粘贴按钮"这条绕过路径。

这比"只看前台窗口"更严：前台是已授权应用、而落点压在另一个应用上时，同样会被拦下。命中 `app_not_granted` 时应**重新截图确认布局**，或为落点上的那个应用补一次 `request_access` —— 不要换个坐标硬试。

Windows 特例：桌面窗口归属 `explorer.exe`（显示名可能是「Windows 资源管理器」），它不在 macOS 的 Finder 豁免名单里，因此**点在桌面上会被拒绝**，除非把「Windows 资源管理器」也授权（它本身会出现在 `request_access` 的候选清单中）。`app_under_point` 在坐标下方没有窗口时会回退为前台应用。

## 键盘

### `type`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `text` | `string` | 是 | 要输入的文本 |

- 输入到当前获得键盘焦点的位置（不指定目标应用）。
- 支持换行（`\n` → Enter、`\t` → Tab）与任意 Unicode（中文、全角标点均正常），不经过 IME，与键盘布局无关。
- 走的是 Unicode `SendInput`，逐字符发送，长文本会比 `write_clipboard` + `ctrl+v` 慢。连续普通字符合并在一次调用里下发，换行与制表符则各自拆成独立的按键调用（`\n` 必须是真正的 Enter，不能按文本插入）。
- 快捷键请改用 `key`。

### `key`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `text` | `string` | 是 | 键或组合键，修饰键用 `+` 连接 |
| `repeat` | `integer` 1–100 | 否 | 重复次数，默认 1 |

- 示例：`"return"`、`"escape"`、`"ctrl+c"`、`"ctrl+shift+tab"`。
- 系统级组合键需要 `systemKeyCombos` 授权，否则报错；其他组合键无需额外授权。
- 可用键名见 `SKILL.md`「按键命名」。`cmd` / `command` / `meta` / `super` 会映射为 `win`。

### `hold_key`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `text` | `string` | 是 | 要按住的键或组合键，如 `"space"`、`"shift+down"` |
| `duration` | `number` 0–100 | 是 | 按住时长（秒） |

先按下组合键内所有键，等待 `duration` 后逆序释放。系统级组合键同样需要 `systemKeyCombos`。

## 应用与窗口

### `open_application`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `app` | `string` | 是 | 应用显示名或 bundle id |

把应用带到前台，未运行则启动。目标应用必须已在会话白名单中（先 `request_access`）。

返回文本按实际结果区分，不再一律说 `Opened`：

| helper 返回 | 工具结果 |
| --- | --- |
| `focused` | `Brought "<显示名>" to the front.` —— 已有窗口被提到前台 |
| `launched` | `Opened "<显示名>".` —— 启动了新进程 |
| `present` | **报错** `state_conflict`：应用在运行但 Windows 拒绝让后台进程抢焦点 |
| `void`（host 无法区分） | `Asked the system to open "<显示名>" — this host cannot confirm it came forward.` |

`present` 走错误而不是成功，是因为旧实现把它报成 `Opened`：模型据此在"应该在的位置"点击，而那个位置其实属于另一个窗口；重试又会多开一个窗口。错误文本明确要求别再调用本工具、先截图看真实前台。两种成功结果都会在多显示器（≥2 块）时追加一句「可能在不同显示器上，用 switch_display 确认」。

`app` 的解析顺序（只在**已授权集合**内匹配，不查安装表，避免热路径上的 `listInstalledApps()` 开销）：

1. 传入的正是已授权的 bundleId → 直接用；
2. 显示名精确匹配（大小写不敏感）；
3. 松匹配（**单向**）：已授权显示名包含输入，或输入等于 bundleId 的可执行文件名（去 `.exe`）—— 这样 `Notepad++` 能找到 `Notepad++ (64-bit x64)`、`pwsh` 能找到 `PowerShell 7`，与 `request_access` 的宽松解析对齐。反向包含是试过之后砍掉的：它会让 `Notepad++` 同时命中一个普通的 `Notepad` 授权，把唯一答案变成假歧义；
4. 松匹配命中**多个** → 返回 `bad_args` 并列出候选，绝不静默挑一个（两者的 tier 与"用户以为批准了什么"可能不同）；
5. 一个都不匹配 → 返回 `app_not_granted`，并把当前已授权的显示名列出来。旧文案在这里只会说「call request_access first」，而应用往往只是名字没对上，于是模型被推进重新授权的循环。

### `switch_display`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `display` | `string` | 是 | 截图说明中给出的显示器名称，或 `"auto"` |

- 名称匹配不区分大小写，解析方式与截图说明中的命名一致（同名显示器会带 `(2)` 之类后缀区分）。
- 传 `"auto"` 恢复自动选择（通常跟随目标应用所在屏）。
- 只有一块显示器时返回 `bad_args`（无可切换目标）；传了不存在的名称时，错误信息会列出可用名称。
- 切换后需要重新 `screenshot` 才能看到新屏内容。

### `wait`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `duration` | `number` 0–100 | 是 | 等待秒数 |

## 剪贴板

- `read_clipboard`：无参数，返回剪贴板文本。需要 `clipboardRead`，否则 `grant_flag_required`。
- `write_clipboard`：必需 `text`（`string`）。需要 `clipboardWrite`。

注意：当前台应用是 `click` tier 时，运行时会把用户剪贴板暂存并清空，直到前台切换走再恢复；这是防止通过右键菜单或界面按钮完成"粘贴"绕过键盘 tier 限制的机制。

## 批处理

### `computer_batch`

一次调用执行一串动作，省去大部分模型→API 往返。适合可预测的序列，例如「点输入框 → 输入 → 回车」。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `actions` | `object[]`（至少 1 项） | 是 | 动作序列 |

动作对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | 枚举，必需 | `key`、`type`、`mouse_move`、`left_click`、`left_click_drag`、`right_click`、`middle_click`、`double_click`、`triple_click`、`scroll`、`hold_key`、`screenshot`、`cursor_position`、`left_mouse_down`、`left_mouse_up`、`wait` |
| `coordinate` | `[x, y]` | 点击 / `mouse_move` / `scroll` / `left_click_drag` 终点 |
| `start_coordinate` | `[x, y]` | 仅 `left_click_drag` 的起点，省略则从当前光标拖 |
| `text` | `string` | `type` 的文本；`key` / `hold_key` 的组合键；点击 / 滚动时的修饰键 |
| `scroll_direction` | `up` / `down` / `left` / `right` | 仅 `scroll` |
| `scroll_amount` | 整数 0–100 | 仅 `scroll` |
| `duration` | `number` 0–100 | 秒，用于 `hold_key` / `wait` |
| `repeat` | 整数 1–100 | 仅 `key` 的重复次数 |

行为：

- 顺序执行，**首个出错的动作即停止**。
- 停止时**不会回滚已执行的动作**：若批次里 `left_mouse_down` 之后某个动作失败，左键会保持按住状态（实测：`[mouse_move, left_mouse_down, left_mouse_down]` 在第三次报 `mouse button already held` 并停止，末尾的 `left_mouse_up` 不会执行）。把 `left_mouse_up` 放在批次里**不能**当作兜底 —— 失败后必须单独调用它释放。
- 返回 JSON：全部成功为 `{ "completed": [...] }`；中途失败为 `{ "completed": [...], "failed": { "action": ..., "index": ..., "error": ... }, "remaining": <未执行数量> }`。
- 每个动作前都会重新校验前台应用白名单；若某动作打开了非白名单应用，下一个动作的门控会失败并终止批处理。
- 批内允许插入 `screenshot` 用于观察，但**后续点击坐标仍以批处理前的全屏截图为基准**。
- 一个批处理等于一次工具调用往返，但内部仍是逐动作执行，不会并行。

## 错误码

`telemetry.error_kind` 的取值（`project/src/vendor/computer-use-mcp/toolCalls.ts`）：

| error_kind | 含义与处置 |
| --- | --- |
| `allowlist_empty` | 白名单为空。先调 `request_access` |
| `app_not_granted` | 前台应用不在白名单。补一次 `request_access` |
| `tier_insufficient` | 应用已授权但 tier 不够（如对 `click` tier 应用发键盘输入）。改用允许的动作或换目标应用 |
| `grant_flag_required` | 缺少 `clipboardRead` / `clipboardWrite` / `systemKeyCombos` 授权 |
| `cu_lock_held` | 桌面被其他 computer-use 会话占用。等对方结束、等空闲接管，或改走非 desktop 路径 |
| `bad_args` | 参数形状 / 取值 / 范围非法，或引用了不存在的目标（如不存在的显示器名） |
| `state_conflict` | 调用顺序或状态不对（如左键已按下时再次按下） |
| `display_error` | 显示器枚举失败（热插拔瞬间等） |
| `capture_failed` | 截图采集失败 |
| `feature_unavailable` | 工具可调用但当前会话未接线（如未注入显示器固定能力） |
| `tcc_not_granted` | 系统权限缺失。Windows 上 `check_permissions` 恒返回已授权，此错误不会出现 |
| `teach_mode_conflict` / `teach_mode_not_active` | teach 相关状态冲突。当前 host 未启用 teach 模式 |
| `executor_threw` | 底层 helper 抛出异常 |
| `other` | 未分类 |

### 门控错误文案

错误文本是「没读 skill 就直接调工具」的 agent 唯一会看到的说明，因此四处文案各自承担一段指引，改动时保持分工：

- `ACCESS_GATE_GUIDANCE`（`toolCalls.ts`）—— 拼在 `allowlist_empty` 与两处 `app_not_granted` 尾部：给出可直接照做的 `request_access` 调用形状、"应用重新构建 / 移动过就要重新授权"这一常见成因（`go run` 每次换 temp 目录就是典型），以及"先加载 computer-use skill"。
- `TIER_ANTI_SUBVERSION`（`toolCalls.ts`）—— 拼在所有 `tier_insufficient` 尾部，也在 `request_access` 的档位说明里前置出现一次。措辞刻意跨平台：点名 PowerShell SendKeys / nircmd / osascript / cliclick，并额外堵住「直接命令行调用 `windows_helper.py`」——本后端的注入器就是个普通 CLI，绕开门控重放任意动作只需一条命令，只写 macOS 那几个工具名等于给这条路留着门。
- `LOCK_HELD_GUIDANCE`（`toolCalls.ts` 导出，`mcpServer.ts` 与 Gate-3 共用）—— 拼在 host 的 `formatLockHeldMessage` 结果与默认文案之后，三处 `cu_lock_held` 出口都覆盖，只讲被挡住这一方能做什么，重点澄清 `release_lock` **只能释放本会话**的锁（否则模型会去调一个注定无效的工具）。空闲接管的具体秒数不在这里说：只有 host 知道自己的策略，`COMPUTER_USE_LOCK_IDLE_SECS=0` 时给出接管承诺比不承诺更糟，所以由 `session.ts` 按实际配置生成。
- `SERVER_INSTRUCTIONS`（`mcpServer.ts`）—— 见「通用约定」，是唯一前置到首次调用之前的文案位。
