/**
 * Build the single-file MCP entry that ships in the distribution zip.
 *
 * An automatic skill upgrade only overwrites files carried by the zip. A `dist/`
 * built on the user's machine is machine-local state: left behind, it keeps
 * serving old code forever because MCP config points at the fixed path
 * `project/dist/cli.js`. So the executable entry itself must be shipped, and it
 * must resolve nothing from `node_modules` (which is likewise never refreshed
 * by an upgrade).
 *
 * esbuild inlines the MCP SDK and every other runtime dependency. Any import
 * left external would silently resurrect the old dependency tree on upgrade,
 * so the metafile is checked before the build is accepted.
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(projectRoot, 'dist', 'cli.js')

await mkdir(path.dirname(outfile), { recursive: true })

const result = await build({
  entryPoints: [path.join(projectRoot, 'src', 'cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
})

const output = Object.values(result.metafile.outputs)[0]
const external = (output.imports ?? []).filter(entry => entry.external)
const unresolved = external.filter(entry => !entry.path.startsWith('node:'))
if (unresolved.length > 0) {
  throw new Error(
    `bundle would resolve packages from node_modules at runtime: ${unresolved
      .map(entry => entry.path)
      .join(', ')}`,
  )
}

console.log(
  `bundled ${Object.keys(output.inputs ?? {}).length} modules -> ${outfile} ` +
    `(${external.length} node: builtins)`,
)
