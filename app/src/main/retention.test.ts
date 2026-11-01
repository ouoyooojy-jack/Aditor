import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library, normalizePath } from './library'
import { ProjectStore } from './projects'
import { cacheFilePath } from './cache-io'
import { RecordingRetention, expiredRecordings, freeName, savedDirFor } from './retention'
import { DAY_MS, RECORDING_RETENTION_DAYS, retentionDaysLeft } from '../shared/storage'

// The real check accepts only Windows drive-letter paths; these tests run on POSIX temp folders too.
vi.mock('./safe-path', async (importOriginal) => ({ ...await importOriginal<typeof import('./safe-path')>(), isSafeLocalVideoPath: (p: unknown) => typeof p === 'string' }))

describe('recording retention rules', () => {
  it('puts the Saved folder next to Recordings, or inside a custom folder', () => {
    expect(savedDirFor(path.join('/v', 'Aditor', 'Recordings'))).toBe(path.resolve('/v', 'Aditor', 'Saved'))
    expect(savedDirFor(path.join('/v', 'Clips'))).toBe(path.resolve('/v', 'Clips', 'Saved'))
  })

  it('counts whole days left', () => {
    const now = 1_000 * DAY_MS
    expect(retentionDaysLeft(now + RECORDING_RETENTION_DAYS * DAY_MS, now)).toBe(30)
    expect(retentionDaysLeft(now + DAY_MS / 2, now)).toBe(1)
    expect(retentionDaysLeft(now - 1, now)).toBe(0)
  })

  it('expires only unsaved, unfavorited, unused recordings past their time', () => {
    const base = { addedAt: 0, favorite: false, status: 'done' as const, progress: 1 }
    const entries = [
      { ...base, path: '/r/old.mp4', source: 'recording' as const, expiresAt: 10 },
      { ...base, path: '/r/fresh.mp4', source: 'recording' as const, expiresAt: 1000 },
      { ...base, path: '/r/saved.mp4', source: 'recording' as const, expiresAt: 10, saved: true },
      { ...base, path: '/r/fav.mp4', source: 'recording' as const, expiresAt: 10, favorite: true },
      { ...base, path: '/r/legacy.mp4', source: 'recording' as const },
      { ...base, path: '/r/import.mp4', source: 'external' as const, expiresAt: 10 },
      { ...base, path: '/r/project.mp4', source: 'recording' as const, expiresAt: 10 },
      { ...base, path: '/r/busy.mp4', source: 'recording' as const, expiresAt: 10, status: 'analyzing' as const }
    ]
    const out = expiredRecordings(entries, { now: 100, referenced: new Set([normalizePath('/r/project.mp4')]) })
    expect(out.map((e) => e.path)).toEqual(['/r/old.mp4'])
  })

  it('finds a free file name', () => {
    const taken = new Set([path.join('/d', 'a.mp4'), path.join('/d', 'a_2.mp4')])
    expect(freeName('/d', 'a.mp4', (f) => taken.has(f))).toBe(path.join('/d', 'a_3.mp4'))
  })
})

describe('RecordingRetention', () => {
  let root: string
  let library: Library
  let projects: ProjectStore
  let retention: RecordingRetention
  let now: number
  const changed = vi.fn()

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-retention-'))
    fs.mkdirSync(path.join(root, 'Recordings', '2026-10-01'), { recursive: true })
    fs.mkdirSync(path.join(root, 'cache'))
    library = new Library(path.join(root, 'library.json'))
    projects = new ProjectStore(path.join(root, 'projects'))
    now = Date.now()
    retention = new RecordingRetention({
      library, projects,
      withStoppedAnalysis: async (_paths, action) => action(),
      recordingsDir: () => path.join(root, 'Recordings'),
      cacheDir: () => path.join(root, 'cache'),
      changed,
      now: () => now
    })
  })
  afterEach(() => { retention.stop(); fs.rmSync(root, { recursive: true, force: true }); changed.mockReset() })

  function recording(name: string): string {
    const file = path.join(root, 'Recordings', '2026-10-01', name)
    fs.writeFileSync(file, 'video')
    library.add([file], 'recording', 'cs2')
    return file
  }

  it('stamps new recordings with an expiry and not imports', () => {
    const file = recording('CS2_a.mp4')
    expect(library.get(file)?.expiresAt).toBeGreaterThan(now + (RECORDING_RETENTION_DAYS - 1) * DAY_MS)
    const imported = path.join(root, 'x.mp4')
    library.add([imported])
    expect(library.get(imported)?.expiresAt).toBeUndefined()
  })

  it('moves a saved recording, its cache and its project references into the Saved folder', async () => {
    const file = recording('CS2_b.mp4')
    const cache = cacheFilePath(file, path.join(root, 'cache'))
    fs.writeFileSync(cache, JSON.stringify({ video: { path: file }, cache_path: cache, events: [{ id: 'k' }] }))
    await projects.save({ id: 'p_1', version: 1, name: 'P', items: [{ id: 'i', source: file, start: 0, end: 1 }] })

    const res = await retention.save(file)
    expect(res.ok).toBe(true)
    const moved = (res as { path: string }).path
    expect(path.dirname(path.dirname(moved))).toBe(path.join(root, 'Saved'))
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(moved, 'utf8')).toBe('video')
    expect(library.get(file)).toBeUndefined()
    expect(library.get(moved)).toMatchObject({ saved: true, expiresAt: undefined })
    const newCache = cacheFilePath(moved, path.join(root, 'cache'))
    expect(JSON.parse(fs.readFileSync(newCache, 'utf8'))).toMatchObject({ video: { path: moved }, cache_path: newCache })
    expect(fs.existsSync(cache)).toBe(false)
    expect((await projects.load('p_1'))?.items[0].source).toBe(moved)
    expect(changed).toHaveBeenCalled()
    expect(await retention.save(moved)).toEqual({ ok: false, reason: 'already_saved' })
  })

  it('deletes expired recordings, and keeps saved ones and those used in a project', async () => {
    const old = recording('CS2_old.mp4')
    const used = recording('CS2_used.mp4')
    const keep = recording('CS2_keep.mp4')
    const saved = (await retention.save(keep) as { path: string }).path
    await projects.save({ id: 'p_2', version: 1, name: 'P', items: [{ id: 'i', source: used, start: 0, end: 1 }] })
    expect(await retention.sweep()).toEqual([])
    now += (RECORDING_RETENTION_DAYS + 1) * DAY_MS
    expect(await retention.sweep()).toEqual([old])
    expect(fs.existsSync(old)).toBe(false)
    expect(library.get(old)).toBeUndefined()
    expect(fs.existsSync(used)).toBe(true)
    expect(fs.existsSync(saved)).toBe(true)
  })
})
