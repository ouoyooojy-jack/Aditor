/**
 * Temporary recordings and the Saved folder.
 *
 * Recordings land in the temporary Recordings folder with an `expiresAt` time RECORDING_RETENTION_DAYS ahead. Saving a
 * recording moves its file (and its analysis cache) into the Saved folder next to Recordings and clears the expiry;
 * a periodic sweep deletes unsaved recordings whose time is up. Entries recorded before this feature carry no
 * `expiresAt` and are never deleted automatically, nor are favorites or recordings used in a project.
 */
import fs from 'fs'
import path from 'path'
import { cacheBelongsToVideo, cacheFilePath } from './cache-io'
import { normalizePath, type Library, type LibraryEntry } from './library'
export { expiryFor } from './library'
import { isSafeLocalVideoPath } from './safe-path'
import { RECORDINGS_DIRNAME, RECORDING_RETENTION_DAYS, SAVED_DIRNAME, dayFolderName } from '../shared/storage'
import { tr } from '../shared/locale'

/** Sweep at startup and then every few hours; recordings expire by the day, so this is precise enough. */
export const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000

/** `<root>/Saved` next to `<root>/Recordings`; a custom recording folder gets its own `Saved` subfolder. */
export function savedDirFor(recordingsDir: string): string {
  const resolved = path.resolve(recordingsDir)
  return path.basename(resolved).toLowerCase() === RECORDINGS_DIRNAME.toLowerCase()
    ? path.join(path.dirname(resolved), SAVED_DIRNAME)
    : path.join(resolved, SAVED_DIRNAME)
}

function inside(file: string, dir: string): boolean {
  const relative = path.relative(normalizePath(dir), normalizePath(file))
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export interface ExpiryOptions {
  now: number
  /** Normalized source paths used by any project. */
  referenced: ReadonlySet<string>
}

/** Unsaved recordings past their expiry that nothing else depends on. */
export function expiredRecordings(entries: readonly LibraryEntry[], { now, referenced }: ExpiryOptions): LibraryEntry[] {
  return entries.filter((e) => e.source === 'recording' && !e.saved && !e.favorite &&
    typeof e.expiresAt === 'number' && e.expiresAt <= now && e.status !== 'analyzing' && !referenced.has(normalizePath(e.path)))
}

/** A free `<dir>/<name>` (adding `_2`, `_3` … before the extension). */
export function freeName(dir: string, base: string, exists: (file: string) => boolean = fs.existsSync): string {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? base : `${stem}_${n}${ext}`)
    if (!exists(file)) return file
  }
}

function moveFileSync(from: string, to: string): void {
  try { fs.renameSync(from, to) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // Another drive: copy without replacing anything, then drop the original.
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
    fs.unlinkSync(from)
  }
}

/** Rewrite the video's analysis caches for its new path; a cache that cannot be moved is left for reanalysis. */
export function moveCachesSync(from: string, to: string, cacheDir: string): void {
  for (const beside of [false, true]) {
    const oldCache = cacheFilePath(from, cacheDir, beside)
    if (!fs.existsSync(oldCache) || !cacheBelongsToVideo(oldCache, from)) continue
    try {
      const doc = JSON.parse(fs.readFileSync(oldCache, 'utf8'))
      const newCache = cacheFilePath(to, cacheDir, beside)
      doc.video = { ...doc.video, path: to }
      doc.cache_path = newCache
      fs.mkdirSync(path.dirname(newCache), { recursive: true })
      fs.writeFileSync(newCache + '.tmp', JSON.stringify(doc), 'utf8')
      fs.renameSync(newCache + '.tmp', newCache)
      fs.unlinkSync(oldCache)
    } catch (error) { console.error('[retention] Failed to move an analysis cache:', error) }
  }
}

export function removeCachesSync(videoPath: string, cacheDir: string): void {
  for (const beside of [false, true]) {
    const cache = cacheFilePath(videoPath, cacheDir, beside)
    try { if (cacheBelongsToVideo(cache, videoPath)) fs.unlinkSync(cache) } catch { /* Best effort. */ }
  }
}

interface ProjectLike { id: string; version: 1; name: string; items: Array<{ source: string }> }

export interface RetentionDeps {
  library: Library
  /** Stops analysis of the paths while `action` runs (AnalysisQueue.withStoppedAnalysis). */
  withStoppedAnalysis: <T>(paths: string[], action: () => T) => Promise<T>
  projects: { list(): Promise<Array<{ id: string }>>; load(id: string): Promise<ProjectLike | null>; save(p: ProjectLike): Promise<void> }
  /** The temporary recording folder currently in use. */
  recordingsDir: () => string
  cacheDir: () => string
  /** The library changed (broadcast it to windows). */
  changed: () => void
  log?: (message: string) => void
  now?: () => number
}

export type SaveResult = { ok: true; path: string } | { ok: false; reason: 'not_found' | 'not_recording' | 'already_saved' | 'failed'; error?: string }

export class RecordingRetention {
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping: Promise<string[]> | null = null

  constructor(private deps: RetentionDeps) {}

  start(): void {
    if (this.timer) return
    void this.sweep()
    this.timer = setInterval(() => void this.sweep(), RETENTION_SWEEP_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  savedDir(): string { return savedDirFor(this.deps.recordingsDir()) }

  /** Move a recording into the Saved folder, keeping its analysis, and stop it from expiring. */
  async save(videoPath: string): Promise<SaveResult> {
    const { library } = this.deps
    const entry = library.get(videoPath)
    if (!entry || !isSafeLocalVideoPath(entry.path)) return { ok: false, reason: 'not_found' }
    if (entry.source !== 'recording') return { ok: false, reason: 'not_recording' }
    if (entry.saved) return { ok: false, reason: 'already_saved' }
    const from = entry.path
    const dir = path.join(this.savedDir(), dayFolderName(entry.addedAt))
    let to: string
    try {
      to = await this.deps.withStoppedAnalysis([from], () => {
        fs.mkdirSync(dir, { recursive: true })
        const target = freeName(dir, path.basename(from))
        moveFileSync(from, target)
        moveCachesSync(from, target, this.deps.cacheDir())
        if (!library.relocate(from, target, { saved: true, expiresAt: undefined })) throw new Error(tr('媒體庫已有同名影片'))
        return target
      })
    } catch (error) {
      return { ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    await this.rewriteProjects(from, to)
    this.deps.changed()
    return { ok: true, path: to }
  }

  /** Delete expired recordings now; returns the deleted paths. Concurrent calls share one sweep. */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.runSweep().finally(() => { this.sweeping = null })
    return this.sweeping
  }

  private async runSweep(): Promise<string[]> {
    const { library } = this.deps
    let referenced: Set<string>
    try { referenced = await this.projectSources() }
    // Without the project list a deletion might break a project, so skip this sweep.
    catch (error) { this.log(`retention skipped: ${String(error)}`); return [] }
    const now = (this.deps.now ?? Date.now)()
    const saved = this.savedDir()
    // A file the user moved into the Saved folder by hand is kept too.
    const expired = expiredRecordings(library.getEntries(), { now, referenced }).filter((e) => !inside(e.path, saved))
    if (!expired.length) return []
    const paths = expired.map((e) => e.path)
    let removed: string[] = []
    try {
      removed = (await this.deps.withStoppedAnalysis(paths, () => library.removeMany(paths))).removed
    } catch (error) { this.log(`retention failed: ${String(error)}`); return [] }
    for (const file of removed) removeCachesSync(file, this.deps.cacheDir())
    if (removed.length) {
      this.log(`retention deleted ${removed.length} recording(s) older than ${RECORDING_RETENTION_DAYS} days`)
      this.deps.changed()
    }
    return removed
  }

  private async projectSources(): Promise<Set<string>> {
    const sources = new Set<string>()
    for (const { id } of await this.deps.projects.list()) {
      const project = await this.deps.projects.load(id)
      for (const item of project?.items ?? []) if (typeof item.source === 'string') sources.add(normalizePath(item.source))
    }
    return sources
  }

  private async rewriteProjects(from: string, to: string): Promise<void> {
    const norm = normalizePath(from)
    try {
      for (const { id } of await this.deps.projects.list()) {
        const project = await this.deps.projects.load(id)
        if (!project?.items.some((item) => normalizePath(item.source) === norm)) continue
        await this.deps.projects.save({ ...project, items: project.items.map((item) => normalizePath(item.source) === norm ? { ...item, source: to } : item) })
      }
    } catch (error) { this.log(`project path update failed: ${String(error)}`) }
  }

  private log(message: string): void {
    try { this.deps.log?.(message) } catch { /* Logging must not affect retention. */ }
    console.log('[retention]', message)
  }
}
