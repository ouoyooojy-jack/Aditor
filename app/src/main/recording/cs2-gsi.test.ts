import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CS2_GSI_CFG_NAME, Cs2Client, Cs2Tracker, gsiConfigText, installGsiConfig, loadOrCreateGsiConfig, parseLibraryFolders,
  type Cs2Event, type GsiPayload
} from './cs2-gsi'

const ME = '76561198000000001'
const MATE = '76561198000000002'

interface Step { phase?: string; round?: string; win?: string; ct?: number; t?: number; kills?: number; deaths?: number; hs?: number; team?: string; who?: string; noMap?: boolean }
function payload(s: Step): GsiPayload {
  return {
    provider: { steamid: ME },
    ...(s.noMap ? {} : { map: { mode: 'competitive', name: 'de_mirage', phase: s.phase ?? 'live', team_ct: { score: s.ct ?? 0 }, team_t: { score: s.t ?? 0 } } }),
    ...(s.round ? { round: { phase: s.round, ...(s.win ? { win_team: s.win } : {}) } } : {}),
    player: { steamid: s.who ?? ME, team: s.team ?? 'CT', match_stats: { kills: s.kills ?? 0, deaths: s.deaths ?? 0 }, state: { round_killhs: s.hs ?? 0 } }
  }
}
const types = (events: Cs2Event[]): string[] => events.map((e) => e.type)

describe('CS2 game state tracker', () => {
  it('starts a match at live, not warmup, and ends it at gameover', () => {
    const tr = new Cs2Tracker()
    expect(tr.next(payload({ phase: 'warmup', kills: 3 }), 0)).toEqual([])
    expect(tr.next(payload({ phase: 'live', round: 'freezetime', kills: 0 }), 1)).toEqual([{ type: 'match_start', at: 1, map: 'de_mirage', mode: 'competitive' }])
    expect(types(tr.next(payload({ phase: 'gameover', kills: 0 }), 2))).toEqual(['match_end'])
  })

  it('keeps halftime and overtime inside one match (a 15:13 game)', () => {
    const tr = new Cs2Tracker()
    const events: Cs2Event[] = []
    events.push(...tr.next(payload({ phase: 'live', round: 'live' }), 0))
    events.push(...tr.next(payload({ phase: 'intermission', round: 'over', win: 'CT', ct: 6, t: 6 }), 1))
    events.push(...tr.next(payload({ phase: 'live', round: 'live', team: 'T', ct: 6, t: 6 }), 2))
    events.push(...tr.next(payload({ phase: 'live', round: 'over', win: 'T', team: 'T', ct: 13, t: 15 }), 3))
    events.push(...tr.next(payload({ phase: 'gameover', round: 'over', win: 'T', team: 'T', ct: 13, t: 15 }), 4))
    expect(types(events)).toEqual(['match_start', 'round_end', 'round_end', 'match_end'])
    expect(events[1]).toMatchObject({ winner: 'ally', ally: 6, enemy: 6 })
    // After the side switch the player is T: a T round win is an ally win and scores are from the player's side.
    expect(events[2]).toMatchObject({ winner: 'ally', ally: 15, enemy: 13 })
  })

  it('emits one round_end per round even though CS2 repeats the over phase', () => {
    const tr = new Cs2Tracker()
    tr.next(payload({ round: 'live' }), 0)
    expect(types(tr.next(payload({ round: 'over', win: 'T', t: 1 }), 1))).toEqual(['round_end'])
    expect(tr.next(payload({ round: 'over', win: 'T', t: 1 }), 2)).toEqual([])
    expect(tr.next(payload({ round: 'freezetime', t: 1 }), 3)).toEqual([])
    expect(tr.next(payload({ round: 'over', win: 'T', t: 2 }), 4)[0]).toMatchObject({ type: 'round_end', winner: 'enemy', ally: 0, enemy: 2 })
  })

  it('counts own kills and deaths, with headshots, and ignores the spectated teammate', () => {
    const tr = new Cs2Tracker()
    tr.next(payload({ round: 'live', kills: 0 }), 0)
    expect(tr.next(payload({ round: 'live', kills: 2, hs: 1 }), 1)).toEqual([
      { type: 'kill', at: 1, headshot: true }, { type: 'kill', at: 1, headshot: false }])
    expect(types(tr.next(payload({ round: 'live', kills: 2, deaths: 1 }), 2))).toEqual(['death'])
    // Dead and spectating: the player block is the teammate and their stats are not ours.
    expect(tr.next(payload({ round: 'live', who: MATE, kills: 9, deaths: 4 }), 3)).toEqual([])
    expect(types(tr.next(payload({ round: 'live', kills: 3 }), 4))).toEqual(['kill'])
  })

  it('ends the match when the player leaves to the menu', () => {
    const tr = new Cs2Tracker()
    tr.next(payload({}), 0)
    expect(types(tr.next(payload({ noMap: true }), 1))).toEqual(['match_end'])
  })

  it('does not count kills from before the match or a stats reset as kills', () => {
    const tr = new Cs2Tracker()
    tr.next(payload({ phase: 'warmup', kills: 7 }), 0)
    expect(types(tr.next(payload({ phase: 'live', kills: 0 }), 1))).toEqual(['match_start'])
    expect(tr.next(payload({ kills: 40 }), 2)).toEqual([])
  })
})

describe('CS2 GSI config', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads Steam library folders', () => {
    const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}'
    expect(parseLibraryFolders(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'])
  })

  it('keeps one token per installation and writes the cfg once', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2gsi-'))
    const config = loadOrCreateGsiConfig(dir)
    expect(loadOrCreateGsiConfig(dir)).toEqual(config)
    expect(gsiConfigText(config)).toContain(`"token" "${config.token}"`)
    const cfg = path.join(dir, 'cfg')
    fs.mkdirSync(cfg)
    expect(await installGsiConfig(config, [cfg])).toEqual([path.join(cfg, CS2_GSI_CFG_NAME)])
    expect(await installGsiConfig(config, [cfg])).toEqual([])
  })
})

describe('CS2 GSI client', () => {
  let client: Cs2Client | null = null
  afterEach(() => { client?.stop(); client = null })

  const post = (port: number, body: unknown): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })

  it('accepts only payloads carrying its token', async () => {
    const port = 39000 + Math.floor(Math.random() * 1000)
    client = new Cs2Client({ config: { port, token: 'a'.repeat(32) } })
    const events: Cs2Event[] = []
    client.on('event', (e: Cs2Event) => events.push(e))
    expect(await client.probe()).toBe(true)
    expect(await post(port, { ...payload({}), auth: { token: 'wrong' } })).toBe(200)
    expect(events).toEqual([])
    expect(await post(port, { ...payload({}), auth: { token: 'a'.repeat(32) } })).toBe(200)
    expect(types(events)).toEqual(['match_start'])
  })

  it('reports a port that is already taken', async () => {
    const port = 40000 + Math.floor(Math.random() * 1000)
    client = new Cs2Client({ config: { port, token: 'b'.repeat(32) } })
    expect(await client.probe()).toBe(true)
    const other = new Cs2Client({ config: { port, token: 'b'.repeat(32) } })
    expect(await other.probe()).toBe(false)
  })
})
