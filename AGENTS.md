# AGENTS.md

本仓库是 `computer-use-windows` skill。以下是硬规则，适用于所有 agent 与后续全部改动。违反即为错误。

## 一、版本号

- 格式固定 `x.y.0`：**第三位恒为 0，不参与计数**；前两位按十进制进一。
- 进位示例：`0.6.0 → 0.7.0 → … → 0.9.0 → 1.0.0 → 1.1.0`。
- 禁止 `0.6.1`、`v0.6.0`、`0.6.0-beta`、日期版本号等任何其它写法。
- `scripts/set_version.py` 的 `VERSION_RE` 与 `--check` 会拒绝非法格式，**不许改宽这个正则**。
- README「更新日志」里的历史版本标题保留原样，只有新条目使用新格式。
- 发版必须用 `python scripts/set_version.py x.y.0` 一次同步七处，**不许手工改其中任何一处**：
  1. `SKILL.md` frontmatter `version`
  2. `SKILL.md` 标题（`# Windows 电脑使用 Skill x.y.0`）
  3. `project/package.json`
  4. `project/package-lock.json` 根 `version`
  5. `project/package-lock.json` 的 `packages[""].version`
  6. `project/src/vendor/computer-use-mcp/mcpServer.ts` 的 `serverInfo` 字面量
  7. `README.md` 标题

## 二、发版流程

1. `python scripts/set_version.py x.y.0`
2. 在 `README.md`「更新日志」**最前面**追加倒序条目：`### x.y.0：中文一句摘要`，不写日期、不加 `v`、不插链接。
3. `cd project && npm test` —— 8 阶段必须全绿；第一阶段 `npm run build` 会生成 `project/dist/cli.js`（tsc 单测产物 + esbuild 自包含单文件 bundle），`version sites` 阶段校验格式与七处一致性。**改过版本号必须重新构建**，否则 bundle 里的 `serverInfo.version` 还是旧值。
4. `python scripts/package_skill.py -o %TEMP%/computer-use-windows-x.y.0.zip`，产物放系统临时目录，不留在仓库。打包脚本会校验 `dist/cli.js` 存在、与 `SKILL.md` 版本一致、且静态 import 全为 `node:*`；不满足直接拒绝出包。
5. 中文单行 commit：`x.y.0：摘要`。
6. **不 push、不打 tag、不建 Release**；仓库无 release workflow，等维护者确认。
7. `AGENTS.md` 已被 `package_skill.py` 排除，不得进入分发 zip。
8. 分发 zip 顶层**只允许** `SKILL.md`、`references/`、`project/` 三项（白名单，不是黑名单）；`project/` 下只允许 `package.json`、`dist/cli.js`、`runtime/windows_helper.py`、`runtime/requirements.txt` 四项，由 `package_skill.py` 的 `PROJECT_RUNTIME_ENTRIES` 精确控制。TypeScript 源码、`tsconfig.json`、`package-lock.json`、构建脚本、`node_modules/`、`.runtime/`、`dist/` 下其它 tsc 产物，以及仓库根的 `.github/`、CI 配置、`AGENTS.md`、`README.md`、`LICENSE`、`scripts/`、编辑器 / agent 元数据一律不得进包；`scripts/tests/test_package_skill.py` 是回归断言。
9. `project/dist/cli.js` 必须是 `npm run build` 产出的自包含 esbuild bundle（运行时只 import `node:*`）。自动升级只覆盖 zip 里有的文件，而 MCP 配置写死该路径 —— 入口不随包替换，用户机器上的旧编译产物就会一直跑旧代码；bundle 内联了 MCP SDK，连旧 `node_modules` 也一并绕开。`package.json` 也必须带：`"type": "module"` 决定 Node 如何加载 `.js`，且 `pythonBridge` 用它的位置定位 `runtime/`。`validate_bundle_entry` 是这条规则的回归断言。

## 三、坐标（改这块之前必读）

- 坐标 = 最近一次 `screenshot` 图像上直接读到的像素，**原样传回**。禁止任何 DPI / 分辨率 / 缩放比 / 降采样换算。
- 服务端换算只在 `scaleCoord`，且只用截图时刻快照的 `displayWidth / screenshot.width`（不用 `1/scaleFactor`）；**不许再加第二处换算**。
- 每个工具返回（含错误）末尾必须追加独立 `[COORD FRAME]` 文本块；**不许改 `content[0]`**（单行 JSON 结果与 `computer_batch` 依赖它）。
- `dispatchAction` 的坐标帧校验不许删：无截图锚点、超出截图图像范围、百分比越界一律拒绝；不许恢复"按 `scaleFactor` 猜一个落点"的兜底。
- 模型可见文案（工具参数描述、`initialize` 指令、`[COORD FRAME]`）**不写任何可乘的比例数字**，也**不承诺可选功能存在**（例如默认关闭的坐标网格）。
- 坐标网格 `COMPUTER_USE_COORD_GRID` 默认关闭；仅 `pixels` 模式 + 显式 `=1` 时绘制，绘制不得改变 `image.size`，`zoom` 与 `normalized_0_100` 恒不绘制。

## 四、环境变量

- `process.env` 是 server 进程启动时从 MCP 配置 `env` 继承的副本。**改任何配置都必须重启 server**（MCP 页面关掉再打开 / 点「重新连接」，或直接重启客户端，都会新建 server 进程；面向用户的提示两种都要给，因为用户可能找不到 MCP 页面入口）；文档和注释里不许再写"无需重启 / 改动即时生效"。
- 启动后锁死（模块加载时求值一次）：`COMPUTER_USE_ENABLED`、`COMPUTER_USE_COORDINATE_MODE`、`COMPUTER_USE_DEBUG`、`COMPUTER_USE_LOCK_IDLE_SECS`。
- 每次工具调用重读：`COMPUTER_USE_PIXEL_VALIDATION`、`COMPUTER_USE_CLIPBOARD_PASTE`、`COMPUTER_USE_CLIPBOARD_GUARD`、`COMPUTER_USE_MOUSE_ANIMATION`、`COMPUTER_USE_FOCUS_BEFORE_ACTION`、`COMPUTER_USE_AUTO_TARGET_DISPLAY`。
- 每次截图重读：`COMPUTER_USE_COORD_GRID`、`COMPUTER_USE_IMAGE_MAX_PX`、`COMPUTER_USE_IMAGE_MAX_TOKENS`。
- "每次重读"只表示没缓存成模块常量；普通用法改不到运行中进程的 env，所以仍要重启。

## 五、测试与文件

- 发版前 `npm test` 8 阶段必须全绿；任何代码改动都要跑。
- 测试只放 `scripts/tests/`；临时产物（截图、裁剪图、zip、日志）一律写系统 `%TEMP%`，**禁止在 skill / project 目录内落盘**，用完删除。
- 测试不注入鼠标 / 键盘输入、不动用户窗口；需要输入的地方打桩。
- 新增断言要对应一个真实 bug；修 bug 时想清楚"哪条断言本来能拦住它"。
- 不要重写或重构 `project/src/vendor/` 的大文件，只做定点编辑。

## 六、提交

- commit message 用中文单行主题：发版为 `vx.y.0：摘要`，其它用社区广泛采用的前缀。
- 文档与注释改动也要提交；收尾保持工作区干净。
