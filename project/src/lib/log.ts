import { format } from 'node:util'

const enabled = process.env.COMPUTER_USE_DEBUG === '1'

export function logDebug(message: string, ...args: unknown[]): void {
  if (!enabled) return
  process.stderr.write(`[computer-use] ${format(message, ...args)}\n`)
}

export function logWarn(message: string, ...args: unknown[]): void {
  process.stderr.write(`[computer-use][warn] ${format(message, ...args)}\n`)
}
