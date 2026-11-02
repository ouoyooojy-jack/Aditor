/**
 * Virtual camera output through the OBS Virtual Camera driver.
 *
 * aditorrec writes the captured game, scaled to NV12, into the shared-memory queue that the OBS Virtual Camera
 * DirectShow filter reads (`recorder/src/vcam.rs`). Any program that opens the "OBS Virtual Camera" device (Discord in a
 * browser, for example) then shows the game without capturing the screen a second time. The filter comes with OBS
 * Studio; OBS itself does not have to be running.
 */
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import type { VirtualCamMode } from '../../shared/recording'

export interface VcamSpec { width: number; height: number; fps: number }

export const VCAM_SPECS: Record<Exclude<VirtualCamMode, 'off'>, VcamSpec> = {
  '720p30': { width: 1280, height: 720, fps: 30 },
  '720p60': { width: 1280, height: 720, fps: 60 },
  '1080p30': { width: 1920, height: 1080, fps: 30 }
}

export function vcamSpec(mode: VirtualCamMode): VcamSpec | null {
  return mode === 'off' ? null : VCAM_SPECS[mode] ?? null
}

/** DirectShow video input device category; OBS registers its filter as an instance named "OBS Virtual Camera". */
const VIDEO_INPUT_CATEGORY = 'HKCR\\CLSID\\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\Instance'
export const OBS_VCAM_NAME = 'OBS Virtual Camera'

/** Whether `reg query … /s /f "OBS Virtual Camera"` output lists the device. */
export function parseVcamQuery(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /^\s*FriendlyName\s+REG_SZ\s+OBS Virtual Camera\s*$/i.test(line))
}

export function obsVirtualCamInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('reg', ['query', VIDEO_INPUT_CATEGORY, '/s', '/f', OBS_VCAM_NAME, '/d'], { windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve(!error && parseVcamQuery(stdout)))
  })
}

/** `%APPDATA%\obs-virtualcam.txt` (`WxHxINTERVAL`, interval in 100 ns), which the filter reads to advertise its format. */
export function vcamFormatText(spec: VcamSpec): string {
  return `${spec.width}x${spec.height}x${Math.floor(10_000_000 / spec.fps)}`
}

export function vcamFormatFile(appData = process.env.APPDATA ?? ''): string {
  return path.join(appData, 'obs-virtualcam.txt')
}

/**
 * Tell the filter which size to offer before the stream starts, so a camera opened first still matches it. OBS writes
 * the same file whenever it starts its own virtual camera.
 */
export async function writeVcamFormat(spec: VcamSpec, file = vcamFormatFile()): Promise<void> {
  if (!path.isAbsolute(file)) return
  await fs.promises.writeFile(file, vcamFormatText(spec), 'utf8')
}
