import path from 'path'

/** Games Aditor can record and analyze; the engine takes the same ids as `--game`. */
export type GameId = 'apex' | 'valorant' | 'cs2'

export interface GameDescriptor {
  id: GameId
  displayName: string
  /** Matches the image name column of `tasklist /FO CSV` (without quotes). */
  process: RegExp
  /** Recording file name prefix, e.g. `Apex_2026-10-20_21-08.mp4`. */
  filePrefix: string
  /** Template folder under `templates/`; Apex keeps the original top-level `icons`/`scene` layout. */
  templateDir: string
  /** Start recording automatically when the game process appears. */
  autoRecord: boolean
  /**
   * The offline engine can analyze footage of this game. CS2 events come only from Game State Integration while
   * recording, so its videos are never sent to the engine and cannot be re-analyzed.
   */
  analyzable: boolean
}

export const GAMES: Record<GameId, GameDescriptor> = {
  // Apex footage can still be imported and analyzed, but this build does not record Apex automatically.
  apex: { id: 'apex', displayName: 'Apex Legends', process: /^r5apex(?:_dx12)?\.exe$/i, filePrefix: 'Apex', templateDir: '', autoRecord: false, analyzable: true },
  valorant: { id: 'valorant', displayName: 'VALORANT', process: /^VALORANT-Win64-Shipping\.exe$/i, filePrefix: 'Valorant', templateDir: 'valorant', autoRecord: true, analyzable: true },
  cs2: { id: 'cs2', displayName: 'Counter-Strike 2', process: /^cs2\.exe$/i, filePrefix: 'CS2', templateDir: 'cs2', autoRecord: true, analyzable: false }
}

export const GAME_IDS = Object.keys(GAMES) as GameId[]
/** Games the offline engine can analyze, for the "analyze as" choices on imported videos. */
export const ANALYZABLE_GAME_IDS = GAME_IDS.filter((id) => GAMES[id].analyzable)
export const DEFAULT_GAME: GameId = 'apex'

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAMES, value)
}

/** Older recordings, caches and library entries carry no game; they were all Apex. */
export function gameOf(value: unknown): GameId {
  return isGameId(value) ? value : DEFAULT_GAME
}

/** `templates/icons` for Apex, `templates/<game>/icons` otherwise; `apexProfileDir` is the shipped `templates/icons`. */
export function gameProfileDir(apexProfileDir: string, game: GameId): string {
  const dir = GAMES[game].templateDir
  return dir ? path.join(path.dirname(apexProfileDir), dir, 'icons') : apexProfileDir
}

export function gameSceneDir(apexProfileDir: string, game: GameId): string {
  return path.join(path.dirname(gameProfileDir(apexProfileDir, game)), 'scene')
}
