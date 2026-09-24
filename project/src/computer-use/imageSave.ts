import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CuSavedImageKind } from '../vendor/computer-use-mcp/types.js'

/** Subdirectory under the OS temp directory that holds saved screenshots. */
const SAVE_DIR_NAME = 'computer-use-windows'

let counter = 0

/**
 * Persist a JPEG the model asked to keep (`save_to_disk: true`) and return its
 * absolute path.
 *
 * Deliberately outside the skill/project tree: `.runtime/` is reserved for the
 * self-bootstrapped venv, and scratch images don't belong in the install
 * directory. The return value is surfaced verbatim to the model, so it has to
 * be a real path the user can open.
 */
export async function saveImageToDisk(
  base64: string,
  kind: CuSavedImageKind,
): Promise<string> {
  const dir = join(tmpdir(), SAVE_DIR_NAME)
  await mkdir(dir, { recursive: true })
  // Timestamp alone is not unique — a batch can produce two screenshots inside
  // the same millisecond, and clobbering one would leave the model holding a
  // path that no longer shows what it thinks it shows.
  counter += 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${kind}-${stamp}-${counter}.jpg`)
  await writeFile(file, Buffer.from(base64, 'base64'))
  return file
}
