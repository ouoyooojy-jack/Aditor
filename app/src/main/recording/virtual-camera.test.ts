import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseVcamQuery, vcamFormatText, vcamSpec, writeVcamFormat } from './virtual-camera'

describe('virtual camera', () => {
  it('maps each mode to an even size and frame rate', () => {
    expect(vcamSpec('off')).toBeNull()
    expect(vcamSpec('720p30')).toEqual({ width: 1280, height: 720, fps: 30 })
    expect(vcamSpec('720p60')).toEqual({ width: 1280, height: 720, fps: 60 })
    expect(vcamSpec('1080p30')).toEqual({ width: 1920, height: 1080, fps: 30 })
  })

  it('writes the format file the way OBS does (interval in 100 ns)', async () => {
    expect(vcamFormatText({ width: 1280, height: 720, fps: 30 })).toBe('1280x720x333333')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-vcam-'))
    try {
      const file = path.join(dir, 'obs-virtualcam.txt')
      await writeVcamFormat({ width: 1920, height: 1080, fps: 30 }, file)
      expect(fs.readFileSync(file, 'utf8')).toBe('1920x1080x333333')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('finds the OBS Virtual Camera in reg query output', () => {
    const found = [
      'HKEY_CLASSES_ROOT\\CLSID\\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\Instance\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}',
      '    FriendlyName    REG_SZ    OBS Virtual Camera',
      '',
      'End of search: 1 match(es) found.'
    ].join('\r\n')
    expect(parseVcamQuery(found)).toBe(true)
    expect(parseVcamQuery('End of search: 0 match(es) found.')).toBe(false)
    expect(parseVcamQuery('    FriendlyName    REG_SZ    OBS Virtual Camera 2')).toBe(false)
  })
})
