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
