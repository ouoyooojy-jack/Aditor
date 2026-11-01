/**
 * Counter-Strike 2 match, round and kill state from Valve's Game State Integration (GSI).
 *
 * CS2 reads every `gamestate_integration_*.cfg` in `game/csgo/cfg` at launch and POSTs JSON game state to the URI it
 * names. Aditor writes one such file pointing at a loopback HTTP server it runs only while recording CS2. GSI is an
 * official, read-only interface: nothing is injected into the game and no screen pixels are analyzed, so CS2 recording
 * needs no detection engine at all.
 *
 * Every payload carries the auth token from the cfg file; payloads with any other token are ignored.
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'

export const CS2_GSI_PORT = 3123
export const CS2_GSI_CFG_NAME = 'gamestate_integration_aditor.cfg'
const MAX_BODY_BYTES = 1024 * 1024
/** A burst of more kills than this between two payloads is a stats reset or a bad payload, not real kills. */
const MAX_KILLS_PER_PAYLOAD = 5

export interface Cs2GsiConfig { port: number; token: string }

/** The parts of a GSI payload Aditor reads (`provider`, `map`, `round`, `player_id`, `player_state`, `player_match_stats`). */
export interface GsiPayload {
  provider?: { steamid?: string }
  map?: {
    mode?: string
    name?: string
    phase?: string
    round?: number
    team_ct?: { score?: number }
    team_t?: { score?: number }
  }
  round?: { phase?: string; win_team?: string }
  player?: {
    steamid?: string
    team?: string
    match_stats?: { kills?: number; deaths?: number; assists?: number }
    state?: { round_kills?: number; round_killhs?: number }
  }
  auth?: { token?: string }
}

export type Cs2Event =
  | { type: 'match_start'; at: number; map: string; mode: string }
  | { type: 'match_end'; at: number }
  | { type: 'round_end'; at: number; winner: 'ally' | 'enemy'; ally: number; enemy: number }
  | { type: 'kill'; at: number; headshot: boolean }
  | { type: 'death'; at: number }

/** Map phases inside a match: halftime (`intermission`) and overtime belong to the same match. */
const MATCH_PHASES = new Set(['live', 'intermission'])

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Turns successive payloads into match, round, kill and death events.
 *
 * A match starts when the map phase becomes `live` (warmup is not part of it) and ends at `gameover` or when the map
 * block disappears (the player left to the main menu). Overtime keeps the `live` phase, so a 15:13 match is one match.
 * Kills and deaths come from the player's own `match_stats`; while the player is dead and spectating, the `player`
 * block describes someone else and is ignored.
 */
export class Cs2Tracker {
  private inMatch = false
  private kills: number | null = null
  private deaths: number | null = null
  private headshots: number | null = null
  private roundOver = false
  private team: string | null = null

  next(p: GsiPayload, at: number): Cs2Event[] {
    const out: Cs2Event[] = []
    const phase = p.map?.phase
    const live = !!phase && MATCH_PHASES.has(phase)
    if (this.inMatch && (!p.map || phase === 'gameover' || !phase)) {
      this.inMatch = false
      this.roundOver = false
      out.push({ type: 'match_end', at })
    }
    const own = !!p.player?.steamid && p.player.steamid === p.provider?.steamid
    if (own && (p.player?.team === 'CT' || p.player?.team === 'T')) this.team = p.player.team
    if (live && !this.inMatch) {
      this.inMatch = true
      this.roundOver = p.round?.phase === 'over'
      out.push({ type: 'match_start', at, map: String(p.map?.name ?? ''), mode: String(p.map?.mode ?? '') })
    }
    if (own) {
      const kills = num(p.player?.match_stats?.kills)
      const deaths = num(p.player?.match_stats?.deaths)
      const hs = num(p.player?.state?.round_killhs)
      if (kills !== null) {
        const gained = this.kills === null ? 0 : kills - this.kills
        if (this.inMatch && gained > 0 && gained <= MAX_KILLS_PER_PAYLOAD) {
          // round_killhs grows within a round and resets at the next one, where the previous count no longer applies.
          const hsGained = hs === null ? 0 : hs >= (this.headshots ?? 0) ? hs - (this.headshots ?? 0) : hs
          for (let i = 0; i < gained; i++) out.push({ type: 'kill', at, headshot: i < hsGained })
        }
        this.kills = kills
      }
      if (hs !== null) this.headshots = hs
      if (deaths !== null) {
        const died = this.deaths === null ? 0 : deaths - this.deaths
        if (this.inMatch && died > 0 && died <= MAX_KILLS_PER_PAYLOAD) for (let i = 0; i < died; i++) out.push({ type: 'death', at })
        this.deaths = deaths
      }
    }
    if (this.inMatch) {
      const over = p.round?.phase === 'over'
      const win = p.round?.win_team
      if (over && !this.roundOver && (win === 'CT' || win === 'T') && this.team) {
        const ct = num(p.map?.team_ct?.score) ?? 0
        const t = num(p.map?.team_t?.score) ?? 0
        const allyCt = this.team === 'CT'
        out.push({ type: 'round_end', at, winner: win === this.team ? 'ally' : 'enemy', ally: allyCt ? ct : t, enemy: allyCt ? t : ct })
      }
      if (p.round?.phase) this.roundOver = over
    }
    return out
  }
}

/** The cfg file CS2 reads at launch; heartbeat keeps a quiet session visible, throttle keeps kill times within ~0.2 s. */
export function gsiConfigText(config: Cs2GsiConfig): string {
  return [
    '"Aditor"',
    '{',
    `  "uri" "http://127.0.0.1:${config.port}/"`,
    '  "timeout" "1.0"',
    '  "buffer" "0.0"',
    '  "throttle" "0.1"',
    '  "heartbeat" "10.0"',
    '  "auth"',
    '  {',
    `    "token" "${config.token}"`,
    '  }',
    '  "data"',
    '  {',
    '    "provider" "1"',
    '    "map" "1"',
    '    "round" "1"',
    '    "player_id" "1"',
    '    "player_state" "1"',
    '    "player_match_stats" "1"',
    '  }',
    '}',
    ''
  ].join('\r\n')
}

/** Library roots from Steam's `libraryfolders.vdf` (`"path" "D:\\SteamLibrary"` lines). */
export function parseLibraryFolders(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) out.push(match[1].replace(/\\\\/g, '\\'))
  return out
}

function steamPathFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null)
      const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout)
      resolve(match ? path.normalize(match[1].trim()) : null)
    })
  })
}

/** `game/csgo/cfg` of every CS2 install found through Steam's library list. */
export async function findCs2CfgDirs(steamPath?: string | null): Promise<string[]> {
  const root = steamPath ?? await steamPathFromRegistry() ??
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam')
  const libraries = new Set<string>([root])
  try { for (const lib of parseLibraryFolders(await fs.promises.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) libraries.add(lib) }
  catch { /* Only the default library. */ }
  const dirs: string[] = []
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg')
    try { if ((await fs.promises.stat(dir)).isDirectory()) dirs.push(dir) } catch { /* Not installed in this library. */ }
  }
  return dirs
}

/** A stable token per installation, kept next to the app settings. */
export function loadOrCreateGsiConfig(appDataDir: string, port = CS2_GSI_PORT): Cs2GsiConfig {
  const file = path.join(appDataDir, 'cs2-gsi.json')
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Cs2GsiConfig>
    if (typeof saved.token === 'string' && /^[0-9a-f]{32}$/.test(saved.token)) return { port, token: saved.token }
  } catch { /* Create a new token below. */ }
  const config = { port, token: randomBytes(16).toString('hex') }
  fs.mkdirSync(appDataDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ token: config.token }), 'utf8')
  return config
}

/**
 * Write the cfg file into every CS2 install that lacks the current one. CS2 reads it at launch, so a game already
 * running picks it up only after a restart; returns the files written.
 */
export async function installGsiConfig(config: Cs2GsiConfig, dirs?: string[]): Promise<string[]> {
  const text = gsiConfigText(config)
  const written: string[] = []
  for (const dir of dirs ?? await findCs2CfgDirs()) {
    const file = path.join(dir, CS2_GSI_CFG_NAME)
    try { if (await fs.promises.readFile(file, 'utf8') === text) continue } catch { /* Missing: write it. */ }
    await fs.promises.writeFile(file, text, 'utf8')
    written.push(file)
  }
  return written
}

export interface Cs2ClientOptions {
  config: Cs2GsiConfig
  now?: () => number
  /** Ignore a dead connection this long before warning that match boundaries may be missing (default 60 s). */
  silenceMs?: number
}

/**
 * Loopback GSI receiver for one recording session. Emits 'event' (Cs2Event) and, once, 'unavailable' (Error) when the
 * port cannot be bound or CS2 stops sending (its heartbeat is 10 s), so the session keeps footage it cannot classify.
 */
export class Cs2Client extends EventEmitter {
  private server: http.Server | null = null
  private tracker = new Cs2Tracker()
  private warned = false
  private lastPayload = 0
  private silenceTimer: ReturnType<typeof setInterval> | null = null

  constructor(private options: Cs2ClientOptions) { super() }

  /** Bind the port; false when another program holds it. */
  async probe(): Promise<boolean> {
    if (this.server) return true
    const server = http.createServer((req, res) => this.handle(req, res))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.config.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
    } catch { return false }
    server.on('error', (error) => this.unavailable(error))
    this.server = server
    return true
  }

  start(): void {
    void this.probe().then((ok) => { if (!ok) this.unavailable(new Error(`CS2 GSI port ${this.options.config.port} is in use`)) })
    const silence = this.options.silenceMs ?? 60_000
    this.lastPayload = this.now()
    this.silenceTimer = setInterval(() => {
      if (this.now() - this.lastPayload > silence) this.unavailable(new Error('CS2 stopped sending game state'))
    }, 5000)
    this.silenceTimer.unref()
  }

  stop(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = null
    this.server?.close()
    this.server?.closeAllConnections?.()
    this.server = null
  }

  /** Feed one payload as if CS2 had posted it (tests and the HTTP handler). */
  receive(payload: GsiPayload): void {
    if (payload?.auth?.token !== this.options.config.token) return
    this.lastPayload = this.now()
    for (const event of this.tracker.next(payload, this.now())) this.emit('event', event)
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  private unavailable(error: Error): void {
    if (this.warned) return
    this.warned = true
    this.emit('unavailable', error)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.writeHead(200).end()
      let payload: GsiPayload
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return }
      this.receive(payload)
    })
  }
}
