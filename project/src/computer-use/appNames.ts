type InstalledAppLike = {
  readonly bundleId: string
  readonly displayName: string
  readonly path: string
}

/**
 * Install roots that hold user-facing Windows applications. Matched against the
 * lowercased, backslash-normalized executable path with `includes` (not
 * `startsWith`) so a non-system drive — `D:\Program Files\...` — still counts.
 *
 * Windows `installed_apps` enumerates the registry's Uninstall keys plus the
 * App Paths keys, so `path` is an `.exe` path rather than a `.app` bundle.
 */
const PATH_ALLOWLIST: readonly string[] = [
  '\\program files\\',
  '\\program files (x86)\\',
  '\\programs\\', // %LOCALAPPDATA%\Programs\<Vendor>\<App>
  '\\appdata\\local\\',
  '\\appdata\\roaming\\',
  '\\steamapps\\common\\',
]

/**
 * Roots that never hold something a model should be offered control of: OS
 * binaries, the servicing/installer stacks, and scratch space. Checked BEFORE
 * the allowlist so a broad allow entry can't re-admit them.
 */
const PATH_BLOCKLIST: readonly string[] = [
  '\\windows\\system32\\',
  '\\windows\\syswow64\\',
  '\\windows\\winsxs\\',
  '\\windows\\servicing\\',
  '\\windows\\installer\\',
  '\\temp\\',
  '\\$recycle.bin\\',
]

const NAME_PATTERN_BLOCKLIST: readonly RegExp[] = [
  /Helper(?:$|\s\()/,
  /Agent(?:$|\s\()/,
  /Service(?:$|\s\()/,
  /Uninstaller(?:$|\s\()/,
  /Updater(?:$|\s\()/,
  /^\./,
  // Windows registry noise that has no UI to drive. The Uninstall/App Paths
  // enumeration surfaces a lot of it.
  /^Update for /i,
  /^Security Update/i,
  /^Hotfix/i,
  /Redistributable/i,
  /^Visual C\+\+/i,
  /^(?:Microsoft )?\.NET\b/i,
  /\bDriver\b/i,
  /\bSDK\b/i,
  /^KB\d+/i,
]

/**
 * Well-known apps worth listing for the model even when their install path
 * misses `PATH_ALLOWLIST` (per-user installs, portable builds, non-standard
 * drives). Windows bundle IDs are normalized executable paths, so matching is
 * by display name, case-insensitively.
 */
const ALWAYS_KEEP_NAMES: ReadonlySet<string> = new Set([
  'brave',
  'calculator',
  'command prompt',
  'discord',
  'explorer',
  'figma',
  'file explorer',
  'github desktop',
  'google chrome',
  'media player',
  'microsoft edge',
  'microsoft excel',
  'microsoft outlook',
  'microsoft powerpoint',
  'microsoft teams',
  'microsoft word',
  'mozilla firefox',
  'notepad',
  'notepad++',
  'notion',
  'obsidian',
  'opera',
  'paint',
  'powershell',
  'snipping tool',
  'slack',
  'steam',
  'telegram',
  'visual studio code',
  'wechat',
  'windows media player',
  'windows powershell',
  'windows terminal',
  'wordpad',
  'zoom',
  '微信',
])

const APP_NAME_ALLOWED = /^[\p{L}\p{M}\p{N}_ .&'()+-]+$/u
const APP_NAME_MAX_LEN = 40
const APP_NAME_MAX_COUNT = 50

/** Windows paths are case-insensitive and arrive with either separator. */
function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase()
}

function isUserFacingPath(path: string, homeDir: string | undefined): boolean {
  const normalized = normalizePath(path)
  if (PATH_BLOCKLIST.some(root => normalized.includes(root))) return false
  if (PATH_ALLOWLIST.some(root => normalized.includes(root))) return true
  if (homeDir) {
    const userRoot = `${normalizePath(homeDir).replace(/\\+$/, '')}\\`
    if (normalized.startsWith(userRoot)) return true
  }
  return false
}

function sanitizeCore(raw: readonly string[], applyCharFilter: boolean): string[] {
  const seen = new Set<string>()
  return raw
    .map(name => name.trim())
    .filter(trimmed => {
      if (!trimmed || trimmed.length > APP_NAME_MAX_LEN) return false
      if (applyCharFilter && !APP_NAME_ALLOWED.test(trimmed)) return false
      if (seen.has(trimmed)) return false
      seen.add(trimmed)
      return true
    })
    .sort((a, b) => a.localeCompare(b))
}

function sanitizeAppNames(raw: readonly string[]): string[] {
  const filtered = sanitizeCore(raw, true)
  if (filtered.length <= APP_NAME_MAX_COUNT) return filtered
  return [
    ...filtered.slice(0, APP_NAME_MAX_COUNT),
    `... and ${filtered.length - APP_NAME_MAX_COUNT} more`,
  ]
}

export function filterAppsForDescription(
  installed: readonly InstalledAppLike[],
  homeDir: string | undefined,
): string[] {
  const alwaysKept: string[] = []
  const rest: string[] = []

  for (const app of installed) {
    if (ALWAYS_KEEP_NAMES.has(app.displayName.trim().toLowerCase())) {
      alwaysKept.push(app.displayName)
      continue
    }
    if (isUserFacingPath(app.path, homeDir) && !NAME_PATTERN_BLOCKLIST.some(re => re.test(app.displayName))) {
      rest.push(app.displayName)
    }
  }

  const sanitizedAlways = sanitizeCore(alwaysKept, false)
  const alwaysSet = new Set(sanitizedAlways)
  return [
    ...sanitizedAlways,
    ...sanitizeAppNames(rest).filter(name => !alwaysSet.has(name)),
  ]
}
