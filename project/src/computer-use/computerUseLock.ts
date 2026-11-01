import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getErrnoCode } from '../lib/errors.js'
import { logDebug, logWarn } from '../lib/log.js'

const LOCK_FILENAME = 'computer-use.lock'
const CONFIG_DIR = join(homedir(), '.computer-use-windows')

type LockContents = {
  sessionId: string
  pid: number
  /** Epoch ms of the holder's last gated tool call. Absent on pre-0.5.0 locks. */
  lastHeartbeat?: number
}

let heldLocally = false

/** Default idle threshold before another session may take over the lock. */
const DEFAULT_IDLE_STEAL_SECS = 300

function readIdleStealMs(): number {
  const raw = process.env.COMPUTER_USE_LOCK_IDLE_SECS?.trim()
  if (!raw) return DEFAULT_IDLE_STEAL_SECS * 1000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    logWarn(
      '[computer-use] ignoring %s=%s (expected a non-negative number of seconds); using %d.',
      'COMPUTER_USE_LOCK_IDLE_SECS',
      raw,
      DEFAULT_IDLE_STEAL_SECS,
    )
    return DEFAULT_IDLE_STEAL_SECS * 1000
  }
  return Math.floor(parsed) * 1000
}

const IDLE_STEAL_MS = readIdleStealMs()

/**
 * Idle threshold in seconds, `0` when takeover is disabled. Exported so the
 * lock-held error can tell a blocked session how long "wait" actually means
 * instead of promising an automatic release that `COMPUTER_USE_LOCK_IDLE_SECS=0`
 * has switched off.
 */
export function idleStealSeconds(): number {
  return Math.floor(IDLE_STEAL_MS / 1000)
}

/**
 * A live holder whose heartbeat is older than the threshold counts as
 * dormant: it stopped making tool calls without releasing the lock (the
 * usual "both IDEs stay open" case). `0` disables stealing entirely, and
 * legacy locks without a heartbeat are never stolen — no evidence of
 * idleness, no takeover.
 */
function isHeartbeatStale(lock: LockContents): boolean {
  if (IDLE_STEAL_MS === 0) return false
  if (lock.lastHeartbeat === undefined) return false
  return Date.now() - lock.lastHeartbeat > IDLE_STEAL_MS
}

export type AcquireResult =
  | { kind: 'acquired'; fresh: boolean }
  | { kind: 'blocked'; by: string }

export type CheckResult =
  | { kind: 'free' }
  | { kind: 'held_by_self' }
  | { kind: 'blocked'; by: string }

function getSessionId(): string {
  return process.env.CODEX_THREAD_ID ?? `pid-${process.pid}`
}

function getLockPath(): string {
  return join(CONFIG_DIR, LOCK_FILENAME)
}

async function readLock(): Promise<LockContents | undefined> {
  try {
    const parsed = JSON.parse(await readFile(getLockPath(), 'utf8'))
    if (typeof parsed?.sessionId === 'string' && typeof parsed?.pid === 'number') {
      return {
        sessionId: parsed.sessionId,
        pid: parsed.pid,
        lastHeartbeat:
          typeof parsed.lastHeartbeat === 'number' ? parsed.lastHeartbeat : undefined,
      }
    }
  } catch {}
  return undefined
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tryCreateExclusive(lock: { sessionId: string; pid: number }): Promise<boolean> {
  try {
    await writeFile(getLockPath(), JSON.stringify(lock), { flag: 'wx' })
    return true
  } catch (error) {
    if (getErrnoCode(error) === 'EEXIST') return false
    throw error
  }
}

export async function checkComputerUseLock(): Promise<CheckResult> {
  const existing = await readLock()
  if (!existing) return { kind: 'free' }
  if (existing.sessionId === getSessionId()) return { kind: 'held_by_self' }
  if (isProcessRunning(existing.pid) && !isHeartbeatStale(existing)) {
    return { kind: 'blocked', by: existing.sessionId }
  }
  logDebug(
    'recovering %s computer-use lock from %s',
    isProcessRunning(existing.pid) ? 'idle' : 'stale',
    existing.sessionId,
  )
  await unlink(getLockPath()).catch(() => {})
  return { kind: 'free' }
}

export async function tryAcquireComputerUseLock(): Promise<AcquireResult> {
  const lock: LockContents = { sessionId: getSessionId(), pid: process.pid, lastHeartbeat: Date.now() }
  await mkdir(CONFIG_DIR, { recursive: true })
  if (await tryCreateExclusive(lock)) {
    heldLocally = true
    return { kind: 'acquired', fresh: true }
  }
  const existing = await readLock()
  if (!existing) {
    await unlink(getLockPath()).catch(() => {})
    if (await tryCreateExclusive(lock)) {
      heldLocally = true
      return { kind: 'acquired', fresh: true }
    }
    return { kind: 'blocked', by: 'unknown' }
  }
  if (existing.sessionId === lock.sessionId) {
    heldLocally = true
    await touchComputerUseLock()
    return { kind: 'acquired', fresh: false }
  }
  if (isProcessRunning(existing.pid) && !isHeartbeatStale(existing)) {
    return { kind: 'blocked', by: existing.sessionId }
  }
  logDebug(
    'recovering %s computer-use lock from %s',
    isProcessRunning(existing.pid) ? 'idle' : 'stale',
    existing.sessionId,
  )
  await unlink(getLockPath()).catch(() => {})
  if (await tryCreateExclusive(lock)) {
    heldLocally = true
    return { kind: 'acquired', fresh: true }
  }
  return { kind: 'blocked', by: 'unknown' }
}

/**
 * Refresh the heartbeat on a lock this session holds. Best-effort — any error
 * is swallowed, a failed touch only makes the lock idle-stealable sooner.
 *
 * Not atomic against a concurrent steal: if another session recovers our lock
 * between the read and the write below, this write clobbers theirs. The window
 * is the read→write gap (well under a millisecond on a warm FS cache) and the
 * loser self-heals — its next tool call re-checks the lock and reports
 * `cu_lock_held` or re-acquires. Concurrent input injection is impossible
 * because every action is gated on the lock.
 */
export async function touchComputerUseLock(): Promise<void> {
  try {
    const existing = await readLock()
    if (!existing || existing.sessionId !== getSessionId()) return
    await writeFile(getLockPath(), JSON.stringify({ ...existing, lastHeartbeat: Date.now() }))
  } catch {}
}

export async function releaseComputerUseLock(): Promise<boolean> {
  const existing = await readLock()
  heldLocally = false
  if (!existing || existing.sessionId !== getSessionId()) return false
  try {
    await unlink(getLockPath())
    return true
  } catch {
    return false
  }
}

export function isLockHeldLocally(): boolean {
  return heldLocally
}
