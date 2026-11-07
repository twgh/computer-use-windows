import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, mkdir, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from '../lib/execFileNoThrow.js'
import { logDebug } from '../lib/log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * `tsc` emits dist/computer-use/pythonBridge.js, the shipped bundle is a single
 * dist/cli.js, and `tsx src/cli.ts` runs from src/computer-use/. A fixed number
 * of `..` segments points at the wrong directory in two of those three, and the
 * bundled entry is the one actually running on a user's machine. package.json
 * is the only anchor that holds for all of them.
 */
function resolveProjectRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error(`cannot locate project root (package.json) from ${startDir}`)
}

const projectRoot = resolveProjectRoot(__dirname)
const runtimeRoot = path.join(projectRoot, 'runtime')
const runtimeStateRoot = path.join(projectRoot, '.runtime')
const venvRoot = path.join(runtimeStateRoot, 'venv')
const requirementsPath = path.join(runtimeRoot, 'requirements.txt')
const helperPath = path.join(runtimeRoot, 'windows_helper.py')
const installStampPath = path.join(runtimeStateRoot, 'requirements.sha256')

let bootstrapPromise: Promise<void> | undefined

function pythonBinPath(): string {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python3')
}

function pipBinPath(): string {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'pip.exe')
    : path.join(venvRoot, 'bin', 'pip')
}

async function createVenv(): Promise<void> {
  if (process.platform === 'win32') {
    const pyLauncher = await execFileNoThrow('py', ['-3', '-m', 'venv', venvRoot], { useCwd: false })
    if (pyLauncher.code === 0) return
    await runOrThrow('python', ['-m', 'venv', venvRoot], 'python venv creation')
    return
  }
  await runOrThrow('python3', ['-m', 'venv', venvRoot], 'python venv creation')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Environment for every Python child process.
 *
 * Python encodes a piped stdout with the locale code page — cp936 on a Chinese
 * Windows install — while the helper writes JSON with `ensure_ascii=False`. The
 * bridge reads stdout with `encoding: 'utf8'`, so without this every non-ASCII
 * character (the "·" in display labels, Chinese app display names, clipboard
 * text) turns into U+FFFD on the way back. Pinning PYTHONIOENCODING is the
 * targeted fix; the helper also reconfigures its own streams defensively.
 */
function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: 'utf-8' }
}

async function runOrThrow(file: string, args: string[], label: string): Promise<string> {
  const { code, stdout, stderr } = await execFileNoThrow(file, args, {
    useCwd: false,
    env: pythonEnv(),
  })
  if (code !== 0) {
    throw new Error(`${label} failed with code ${code}: ${stderr || stdout || 'unknown error'}`)
  }
  return stdout
}

async function ensureBootstrapped(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    await mkdir(runtimeStateRoot, { recursive: true })

    if (!(await pathExists(pythonBinPath()))) {
      logDebug('creating runtime venv at %s', venvRoot)
      await createVenv()
    }

    if (!(await pathExists(pipBinPath()))) {
      logDebug('bootstrapping pip with ensurepip')
      await runOrThrow(pythonBinPath(), ['-m', 'ensurepip', '--upgrade'], 'ensurepip')
    }

    const requirements = await readFile(requirementsPath, 'utf8')
    const digest = createHash('sha256').update(requirements).digest('hex')
    let installedDigest = ''
    try {
      installedDigest = (await readFile(installStampPath, 'utf8')).trim()
    } catch {}

    if (installedDigest !== digest) {
      logDebug('installing python runtime dependencies')
      await runOrThrow(pythonBinPath(), ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip upgrade')
      await runOrThrow(
        pythonBinPath(),
        ['-m', 'pip', 'install', '-r', requirementsPath],
        'python dependency install',
      )
      await writeFile(installStampPath, `${digest}\n`, 'utf8')
    }
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    bootstrapPromise = undefined
    throw error
  }
}

export async function callPythonHelper<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensureBootstrapped()
  const { code, stdout, stderr } = await execFileNoThrow(
    pythonBinPath(),
    [helperPath, command, '--payload', JSON.stringify(payload)],
    { useCwd: false, env: pythonEnv() },
  )

  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr || `Python helper ${command} failed with code ${code}`)
  }

  let parsed: { ok: boolean; result?: T; error?: { message?: string } }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(stderr || stdout || `Python helper ${command} returned invalid JSON`)
  }

  if (!parsed.ok) {
    throw new Error(parsed.error?.message || `Python helper ${command} failed`)
  }

  return parsed.result as T
}

export function getRuntimePaths(): { projectRoot: string; runtimeRoot: string; venvRoot: string } {
  return { projectRoot, runtimeRoot, venvRoot }
}
