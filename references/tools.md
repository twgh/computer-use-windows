# MCP 工具参考

本文件是 `SKILL.md` 的深度参考。工具 schema 定义于 `project/src/vendor/computer-use-mcp/tools.ts`，分发与门控逻辑在 `project/src/vendor/computer-use-mcp/toolCalls.ts`。

共 24 个工具。`teach_step` / `teach_batch` / `request_teach_access` 仅在 capabilities 带 `teachMode` 时注册，当前 CLI host（`project/src/computer-use/common.ts`）未开启，因此不可用。

## 通用约定

- 坐标一律是 `[x, y]` 两元素数组，语义见 `SKILL.md`「坐标规则」。
- 成功结果为文本；结构化结果以单行 JSON 文本返回（如 `request_access`、`list_granted_applications`、`computer_batch`）。
- 失败结果带 `isError: true` 与 `telemetry.error_kind`（`telemetry` 在返回 SDK 前被剥离，客户端看不到）。错误文本已分类，不含文件路径等敏感内容。
- `screenshot` / `zoom` 的 `save_to_disk` 参数**当前未实现**，传了不会写盘。
- 除 `request_access` / `list_granted_applications` 外，所有工具都受白名单与 tier 门控（见 `SKILL.md`「权限与门控」）。

## 会话与访问控制

### `request_access`

在调用任何其他工具之前必须调用。用于申请操作一组应用的权限。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `apps` | `string[]` | 是 | 应用显示名（如 `"记事本"`）或 bundle id。显示名按大小写不敏感匹配已安装应用。工具描述里会列出本机可用应用名 |
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

- 中途可以再次调用以追加应用；已授权的应用保持授权且不会重复出现在 `granted` 中。
- `denied` 里 `reason: not_installed` 表示名字没解析到已安装应用 —— 换显示名或 bundle id 重试。
- 走的是「先整体解析、再按优先级剔除」的流程（策略拒绝 > 用户拒绝 > tier），被剔除的应用不会进入授权。
- 该工具**不触发**桌面会话锁的获取，首个实际动作工具才会持锁。

### `list_granted_applications`

无参数。返回当前会话白名单与授权 flag：

```json
{ "allowedApps": [...], "grantFlags": { "clipboardRead": false, "clipboardWrite": false, "systemKeyCombos": false } }
```

## 截图

### `screenshot`

截取当前目标显示器。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `save_to_disk` | `boolean` | 否 | 声明为"保存到磁盘并返回路径"，**当前实现忽略该参数** |

- 白名单为空时返回错误 `allowlist_empty`，不会返回图像。
- 返回内容为一段可选文本 + JPEG 图像。文本仅在条件满足时出现：显示器 ≥ 2 块且（首次截图或目标显示器发生变化）时，说明本次截图所在显示器并列出其他显示器；若上次截图后有小动作被隐藏的窗口，会提示原因。
- 返回的图像就是后续所有点击坐标的参照系。

### `zoom`

对**上一张全屏截图**的某个区域做高分辨率放大，用于读小字、按钮标签等细节。只读，不改变坐标系。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `region` | `[x0, y0, x1, y1]` | 是 | 矩形区域，坐标空间与最近一次全屏截图一致；`(x0,y0)` 左上、`(x1,y1)` 右下 |
| `save_to_disk` | `boolean` | 否 | 同上，未实现 |

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

## 键盘

### `type`

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `text` | `string` | 是 | 要输入的文本 |

- 输入到当前获得键盘焦点的位置（不指定目标应用）。
- 支持换行（`\n` → Enter、`\t` → Tab）与任意 Unicode（中文、全角标点均正常），不经过 IME，与键盘布局无关。
- 走的是 Unicode `SendInput`，逐字符发送，长文本会比 `write_clipboard` + `ctrl+v` 慢。
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
| `cu_lock_held` | 桌面被其他 computer-use 会话占用。等待其结束 |
| `bad_args` | 参数形状 / 取值 / 范围非法，或引用了不存在的目标（如不存在的显示器名） |
| `state_conflict` | 调用顺序或状态不对（如左键已按下时再次按下） |
| `display_error` | 显示器枚举失败（热插拔瞬间等） |
| `capture_failed` | 截图采集失败 |
| `feature_unavailable` | 工具可调用但当前会话未接线（如未注入显示器固定能力） |
| `tcc_not_granted` | 系统权限缺失。Windows 上 `check_permissions` 恒返回已授权，此错误不会出现 |
| `teach_mode_conflict` / `teach_mode_not_active` | teach 相关状态冲突。当前 host 未启用 teach 模式 |
| `executor_threw` | 底层 helper 抛出异常 |
| `other` | 未分类 |
