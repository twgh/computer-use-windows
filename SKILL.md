---
name: computer-use-windows
version: 0.1.1
description: Top-level Windows computer-use skill with a bundled standalone runtime that bootstraps itself and works with any MCP-capable agent client, with no private native modules or extracted app assets.
tags:
  - skill
  - windows
  - computer-use
  - automation
  - mcp
---

# Windows Computer-Use Skill 0.1.1

Use this skill when the task needs a portable Windows computer-use skill bundled with its own standalone runtime and MCP server.

## What this skill does

- uses the bundled `computer-use-windows` project under the installed skill directory
- builds the standalone MCP server
- lets the server auto-bootstrap its Python runtime on first launch
- avoids any dependency on a specific agent client's local binaries, `.node` modules, or extracted app assets
- stays explicitly Windows-only because the underlying desktop-control backend is Windows-specific

## Bundled project path

The bundled standalone project lives at `./project`, relative to the installed skill directory (for example `~/.agents/skills/computer-use-windows/project`). All paths below are relative to the skill root.

## Build

Always build from the bundled project:

```bash
cd ./project
npm install
npm run build
```

## Run

```bash
cd ./project
node dist/cli.js
```

The first real run will automatically create `./project/.runtime/venv` and install the public Python dependencies.

## Guardrails

- Treat this host as trusted-local only.
- Do not tell the user to search any agent client's local install for binaries or hidden assets.
- Never create scratch or temporary files (screenshots, decoded images, JSON dumps, test outputs, logs) inside the skill or project directory — write them to the OS temp directory instead (on Windows: `%TEMP%`, e.g. `C:\Users\<user>\AppData\Local\Temp`; on Unix: `$TMPDIR`). The only things allowed under `project/.runtime/` are the self-bootstrapped venv and its lock/config data. Clean up any scratch files you created when the task finishes.
- Be explicit that this runtime is standalone and uses public dependencies only.
- Mention that the current runtime reports `screenshotFiltering: none`, so action gating is handled at the MCP layer.
