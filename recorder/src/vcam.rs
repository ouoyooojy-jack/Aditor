//! Virtual camera feed: scale captured frames to NV12 on the GPU and write them into the OBS Virtual Camera
//! shared-memory queue, so any program that opens the "OBS Virtual Camera" device (a browser running Discord, for
//! example) shows the game without capturing the screen a second time.
//!
//! The queue format follows obs-studio `shared/obs-shared-memory-queue` (GPL-2.0-or-later); the DirectShow filter
//! that reads it is installed with OBS Studio. Named file mapping `OBSVirtualCamVideo` (session namespace):
//!
//! ```text
//! Header (MSVC x64 layout of `struct queue_header`, 80 bytes; slot 0 starts at the next 32-byte boundary)
//!   0 u32 write_idx   4 u32 read_idx   8 u32 state (1 starting, 2 ready, 3 stopping)
//!  12 u32 offsets[3]  24 u32 type (0 = video)  28 u32 cx  32 u32 cy  40 u64 interval (100 ns units)
//!  48 u32 reserved[8]
//! Slot i at offsets[i]: u64 timestamp (ns), padding to 32 bytes, then NV12: cx*cy luma, cx*cy/2 interleaved chroma.
//! Each slot ends on a 32-byte boundary.
//! ```
//!
//! Writer: `inc = ++write_idx`, fill slot `inc % 3`, then `read_idx = inc` and `state = ready`. The reader always
//! shows slot `read_idx % 3`, which the writer is not filling. Closing sets `state = stopping`, and the filter shows
//! its placeholder image.
//!
//! GPU work never waits: the frame is scaled into an NV12 render target, copied into one of two staging textures, and
//! read back one sample later only if the GPU has finished; otherwise that sample is dropped.

use std::sync::atomic::{fence, AtomicU32, Ordering};

use anyhow::{bail, ensure, Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};

use crate::clock::TICKS_PER_SEC;
use crate::encode::Nv12Scaler;
use crate::gpu::Gpu;
use crate::types::VcamSpec;

pub const QUEUE_NAME: &str = "OBSVirtualCamVideo";
const HEADER_BYTES: usize = 80;
const FRAME_HEADER_BYTES: usize = 32;
const STATE_STARTING: u32 = 1;
const STATE_READY: u32 = 2;
const STATE_STOPPING: u32 = 3;
const MAX_WIDTH: u32 = 3840;
const MAX_HEIGHT: u32 = 2160;

const OFF_WRITE_IDX: usize = 0;
const OFF_READ_IDX: usize = 4;
const OFF_STATE: usize = 8;
const OFF_OFFSETS: usize = 12;
const OFF_TYPE: usize = 24;
const OFF_CX: usize = 28;
const OFF_CY: usize = 32;
const OFF_INTERVAL: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueLayout {
    pub offsets: [u32; 3],
    pub total: u32,
    pub frame_bytes: u32,
}

const fn align32(n: u32) -> u32 {
    (n + 31) & !31
}

/// Slot offsets and mapping size, computed exactly as `video_queue_create` does.
pub fn queue_layout(width: u32, height: u32) -> QueueLayout {
    let frame_bytes = width * height * 3 / 2;
    let mut size = align32(HEADER_BYTES as u32);
    let mut offsets = [0; 3];
    for offset in &mut offsets {
        *offset = size;
        size = align32(size + frame_bytes + FRAME_HEADER_BYTES as u32);
    }
    QueueLayout {
        offsets,
        total: size,
        frame_bytes,
    }
}

/// Frame interval in 100 ns units, as OBS writes it (`fps_den * 10000000 / fps_num`).
pub fn interval_100ns(fps: u32) -> u64 {
    10_000_000 / u64::from(fps.max(1))
}

pub fn validate(spec: VcamSpec) -> Result<()> {
    ensure!(
        spec.width >= 2
            && spec.height >= 2
            && spec.width.is_multiple_of(2)
            && spec.height.is_multiple_of(2),
        "Virtual camera size must be even and nonzero"
    );
    ensure!(
        spec.width <= MAX_WIDTH && spec.height <= MAX_HEIGHT,
        "Virtual camera size must be at most {MAX_WIDTH}×{MAX_HEIGHT}"
    );
    ensure!(
        (1..=60).contains(&spec.fps),
        "Virtual camera frame rate must be 1–60 fps"
    );
    Ok(())
}

/// Accept at most `fps` frames per second of capture time (pts in 100 ns ticks), by time bucket.
struct FrameGate {
    fps: u32,
    last_bucket: Option<i64>,
}

impl FrameGate {
    fn new(fps: u32) -> Self {
        Self {
            fps,
            last_bucket: None,
        }
    }

    fn accept(&mut self, pts: i64) -> bool {
        if pts < 0 {
            return false;
        }
        let bucket = (pts as i128 * self.fps as i128 / TICKS_PER_SEC as i128) as i64;
        if self.last_bucket.is_some_and(|last| bucket <= last) {
            return false;
        }
        self.last_bucket = Some(bucket);
        true
    }
}

/// Writer side of the OBS Virtual Camera queue.
pub struct VideoQueue {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    layout: QueueLayout,
    width: usize,
    height: usize,
}

// SAFETY: The mapping is owned by this writer and accessed only through &mut self; readers are other processes.
unsafe impl Send for VideoQueue {}

impl VideoQueue {
    /// Fails when another writer (OBS with its virtual camera started, or another Aditor) already owns the queue.
    pub fn create(spec: VcamSpec) -> Result<Self> {
        validate(spec)?;
        let name: Vec<u16> = QUEUE_NAME.encode_utf16().chain(Some(0)).collect();
        // SAFETY: The name is NUL-terminated; a successful open only tells us the queue exists and is closed at once.
        if let Ok(existing) =
            unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())) }
        {
            // SAFETY: The handle was just returned by OpenFileMappingW.
            unsafe {
                let _ = CloseHandle(existing);
            }
            bail!("The OBS Virtual Camera is already in use (is the OBS virtual camera started?)");
        }
        let layout = queue_layout(spec.width, spec.height);
        // SAFETY: Pagefile-backed mapping of a validated size with a NUL-terminated name.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                layout.total,
                PCWSTR(name.as_ptr()),
            )
        }
        .context("Failed to create the virtual camera queue")?;
        // SAFETY: Maps the whole mapping just created; the view is unmapped in Drop.
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0) };
        if view.Value.is_null() {
            // SAFETY: Closing the handle created above.
            unsafe {
                let _ = CloseHandle(handle);
            }
            bail!("Failed to map the virtual camera queue");
        }
        let queue = Self {
            handle,
            view,
            layout,
            width: spec.width as usize,
            height: spec.height as usize,
        };
        // SAFETY: The view is at least HEADER_BYTES long and no reader treats the header as valid before state is set.
        unsafe {
            let base = queue.base();
            std::ptr::write_bytes(base, 0, HEADER_BYTES);
            for (i, offset) in layout.offsets.iter().enumerate() {
                base.add(OFF_OFFSETS + i * 4).cast::<u32>().write(*offset);
            }
            base.add(OFF_TYPE).cast::<u32>().write(0);
            base.add(OFF_CX).cast::<u32>().write(spec.width);
            base.add(OFF_CY).cast::<u32>().write(spec.height);
            base.add(OFF_INTERVAL)
                .cast::<u64>()
                .write(interval_100ns(spec.fps));
            fence(Ordering::Release);
            queue
                .atomic(OFF_STATE)
                .store(STATE_STARTING, Ordering::Release);
        }
        Ok(queue)
    }

    fn base(&self) -> *mut u8 {
        self.view.Value.cast()
    }

    /// SAFETY: `offset` must be one of the 4-byte-aligned header fields.
    unsafe fn atomic(&self, offset: usize) -> &AtomicU32 {
        &*self.base().add(offset).cast::<AtomicU32>()
    }

    /// Copy one NV12 frame whose luma rows are `pitch` bytes apart and whose chroma plane starts `pitch * height`
    /// bytes after `data` (the layout of a mapped D3D11 NV12 staging texture of this queue's size).
    ///
    /// SAFETY: `data` must be readable for `pitch * height * 3 / 2` bytes and `pitch` at least the queue width.
    pub unsafe fn write_mapped(&mut self, timestamp_ns: u64, data: *const u8, pitch: usize) {
        let write_idx = self.atomic(OFF_WRITE_IDX);
        let inc = write_idx.load(Ordering::Relaxed).wrapping_add(1);
        write_idx.store(inc, Ordering::Relaxed);
        let slot = self
            .base()
            .add(self.layout.offsets[(inc % 3) as usize] as usize);
        slot.cast::<u64>().write(timestamp_ns);
        let frame = slot.add(FRAME_HEADER_BYTES);
        let (w, h) = (self.width, self.height);
        for row in 0..h {
            std::ptr::copy_nonoverlapping(data.add(row * pitch), frame.add(row * w), w);
        }
        let chroma_src = data.add(pitch * h);
        let chroma_dst = frame.add(w * h);
        for row in 0..h / 2 {
            std::ptr::copy_nonoverlapping(chroma_src.add(row * pitch), chroma_dst.add(row * w), w);
        }
        fence(Ordering::Release);
        self.atomic(OFF_READ_IDX).store(inc, Ordering::Release);
        self.atomic(OFF_STATE).store(STATE_READY, Ordering::Release);
    }
}

impl Drop for VideoQueue {
    fn drop(&mut self) {
        // SAFETY: The view and handle are valid until here; readers see `stopping` and show their placeholder.
        unsafe {
            self.atomic(OFF_STATE)
                .store(STATE_STOPPING, Ordering::Release);
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.handle);
        }
    }
}

struct Staging {
    texture: ID3D11Texture2D,
    ready: ID3D11Query,
    pending: Option<i64>,
}

/// Feeds captured frames to the virtual camera at `spec.fps`, called from the capture callback.
pub struct VirtualCam {
    gpu: Gpu,
    spec: VcamSpec,
    gate: FrameGate,
    scaler: Option<Nv12Scaler>,
    target: ID3D11Texture2D,
    slots: [Staging; 2],
    next: usize,
    queue: VideoQueue,
    written: u64,
    dropped: u64,
    last_error: Option<String>,
}

// SAFETY: All D3D11 objects come from Gpu's multithread-protected device; state is accessed only through &mut.
unsafe impl Send for VirtualCam {}

impl VirtualCam {
    pub fn new(gpu: &Gpu, spec: VcamSpec) -> Result<Self> {
        let queue = VideoQueue::create(spec)?;
        let size = (spec.width, spec.height);
        Ok(Self {
            gpu: gpu.clone(),
            spec,
            gate: FrameGate::new(spec.fps),
            scaler: None,
            target: nv12_texture(gpu, size, false)?,
            slots: [staging(gpu, size)?, staging(gpu, size)?],
            next: 0,
            queue,
            written: 0,
            dropped: 0,
            last_error: None,
        })
    }

    pub fn on_frame(&mut self, texture: &ID3D11Texture2D, width: u32, height: u32, pts: i64) {
        if width == 0 || height == 0 || !self.gate.accept(pts) {
            return;
        }
        match self.sample(texture, width, height, pts) {
            Ok(()) => self.last_error = None,
            Err(error) => {
                self.dropped += 1;
                let message = format!("{error:#}");
                if self.last_error.as_ref() != Some(&message) {
                    eprintln!("Virtual camera frame failed: {message}");
                    self.last_error = Some(message);
                }
            }
        }
    }

    fn sample(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        pts: i64,
    ) -> Result<()> {
        if self.scaler.as_ref().map(Nv12Scaler::source) != Some((width, height)) {
            self.scaler = Some(Nv12Scaler::new(
                &self.gpu,
                (width, height),
                (self.spec.width, self.spec.height),
            )?);
        }
        self.scaler
            .as_mut()
            .context("Missing virtual camera scaler")?
            .convert(texture, &self.target)?;
        let previous = 1 - self.next;
        self.publish(previous)?;
        let slot = &mut self.slots[self.next];
        if slot.pending.is_some() {
            self.dropped += 1;
        }
        // SAFETY: Same device, size and NV12 format; the event query only marks this copy's completion.
        unsafe {
            self.gpu.context.CopyResource(&slot.texture, &self.target);
            self.gpu.context.End(&slot.ready);
            // No Present on this device: submit the commands without waiting for them.
            self.gpu.context.Flush();
        }
        slot.pending = Some(pts);
        self.next = previous;
        Ok(())
    }

    /// Write the slot's frame to the queue if its copy has finished; never waits for the GPU.
    fn publish(&mut self, index: usize) -> Result<()> {
        let slot = &mut self.slots[index];
        let Some(pts) = slot.pending else {
            return Ok(());
        };
        let mut complete = windows::core::BOOL::default();
        // SAFETY: Reads the event query as BOOL without flushing or waiting.
        unsafe {
            self.gpu.context.GetData(
                &slot.ready,
                Some((&mut complete as *mut windows::core::BOOL).cast()),
                std::mem::size_of_val(&complete) as u32,
                D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
            )?
        };
        if !complete.as_bool() {
            return Ok(());
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: The staging texture is used only here; DO_NOT_WAIT returns at once if the GPU is still busy.
        match unsafe {
            self.gpu.context.Map(
                &slot.texture,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => return Ok(()),
            Err(error) => {
                return Err(error).context("Failed to map the virtual camera staging texture")
            }
        }
        // SAFETY: A mapped NV12 staging texture holds `RowPitch * height` luma bytes followed by the chroma plane.
        unsafe {
            self.queue.write_mapped(
                (pts.max(0) as u64).saturating_mul(100),
                mapped.pData.cast(),
                mapped.RowPitch as usize,
            );
            self.gpu.context.Unmap(&slot.texture, 0);
        }
        slot.pending = None;
        self.written += 1;
        Ok(())
    }
}

impl Drop for VirtualCam {
    fn drop(&mut self) {
        eprintln!(
            "Virtual camera stats: written {} dropped {}",
            self.written, self.dropped
        );
    }
}

fn nv12_texture(gpu: &Gpu, size: (u32, u32), staging: bool) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.0,
        Height: size.1,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: if staging {
            D3D11_USAGE_STAGING
        } else {
            D3D11_USAGE_DEFAULT
        },
        BindFlags: if staging {
            0
        } else {
            D3D11_BIND_RENDER_TARGET.0 as u32
        },
        CPUAccessFlags: if staging {
            D3D11_CPU_ACCESS_READ.0 as u32
        } else {
            0
        },
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: desc fully describes a single-layer NV12 texture with even dimensions; the windows crate owns the output.
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut texture))?
    };
    texture.context("Creating the virtual camera texture returned no object")
}

fn staging(gpu: &Gpu, size: (u32, u32)) -> Result<Staging> {
    let mut ready = None;
    // SAFETY: Creates only a GPU completion event; the windows crate owns the output.
    unsafe {
        gpu.device.CreateQuery(
            &D3D11_QUERY_DESC {
                Query: D3D11_QUERY_EVENT,
                MiscFlags: 0,
            },
            Some(&mut ready),
        )?
    };
    Ok(Staging {
        texture: nv12_texture(gpu, size, true)?,
        ready: ready.context("Missing virtual camera completion event")?,
        pending: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_obs_video_queue_create() {
        // 1280×720: header 80 → 96; each slot = 1382400 + 32 bytes, aligned to 32.
        let layout = queue_layout(1280, 720);
        assert_eq!(layout.frame_bytes, 1_382_400);
        assert_eq!(layout.offsets, [96, 96 + 1_382_432, 96 + 2 * 1_382_432]);
        assert_eq!(layout.total, 96 + 3 * 1_382_432);
        // Odd frame sizes still align every slot to 32 bytes.
        let odd = queue_layout(2, 2);
        assert_eq!(odd.offsets, [96, 96 + 64, 96 + 128]);
    }

    #[test]
    fn header_offsets_match_the_msvc_struct() {
        #[repr(C)]
        struct QueueHeader {
            write_idx: u32,
            read_idx: u32,
            state: u32,
            offsets: [u32; 3],
            kind: u32,
            cx: u32,
            cy: u32,
            interval: u64,
            reserved: [u32; 8],
        }
        assert_eq!(std::mem::size_of::<QueueHeader>(), HEADER_BYTES);
        assert_eq!(std::mem::offset_of!(QueueHeader, read_idx), OFF_READ_IDX);
        assert_eq!(std::mem::offset_of!(QueueHeader, state), OFF_STATE);
        assert_eq!(std::mem::offset_of!(QueueHeader, offsets), OFF_OFFSETS);
        assert_eq!(std::mem::offset_of!(QueueHeader, kind), OFF_TYPE);
        assert_eq!(std::mem::offset_of!(QueueHeader, cx), OFF_CX);
        assert_eq!(std::mem::offset_of!(QueueHeader, cy), OFF_CY);
        assert_eq!(std::mem::offset_of!(QueueHeader, interval), OFF_INTERVAL);
    }

    #[test]
    fn gate_limits_the_frame_rate() {
        let mut gate = FrameGate::new(30);
        let frame = TICKS_PER_SEC / 60;
        let accepted = (0..60).filter(|i| gate.accept(i * frame)).count();
        assert_eq!(accepted, 30);
        assert!(!gate.accept(-1));
    }

    #[test]
    fn interval_and_validation() {
        assert_eq!(interval_100ns(30), 333_333);
        assert_eq!(interval_100ns(60), 166_666);
        assert!(validate(VcamSpec {
            width: 1280,
            height: 720,
            fps: 30
        })
        .is_ok());
        assert!(validate(VcamSpec {
            width: 1279,
            height: 720,
            fps: 30
        })
        .is_err());
        assert!(validate(VcamSpec {
            width: 1280,
            height: 720,
            fps: 0
        })
        .is_err());
        assert!(validate(VcamSpec {
            width: 7680,
            height: 4320,
            fps: 30
        })
        .is_err());
    }

    #[test]
    fn writes_frames_the_way_the_obs_reader_reads_them() {
        let spec = VcamSpec {
            width: 4,
            height: 2,
            fps: 30,
        };
        let Ok(mut queue) = VideoQueue::create(spec) else {
            // OBS's virtual camera (or another test) owns the queue on this machine.
            return;
        };
        let pitch = 8;
        let mut source = vec![0u8; pitch * 2 * 3 / 2];
        for (i, byte) in source.iter_mut().enumerate() {
            *byte = i as u8;
        }
        // SAFETY: source holds pitch * height * 3 / 2 bytes with pitch >= width.
        unsafe { queue.write_mapped(1234, source.as_ptr(), pitch) };
        let base = queue.base();
        // SAFETY: Reads header fields and the written slot inside the mapping.
        unsafe {
            assert_eq!(queue.atomic(OFF_STATE).load(Ordering::Acquire), STATE_READY);
            let inc = queue.atomic(OFF_READ_IDX).load(Ordering::Acquire);
            assert_eq!(inc, 1);
            let slot = base.add(queue.layout.offsets[(inc % 3) as usize] as usize);
            assert_eq!(slot.cast::<u64>().read(), 1234);
            let frame = std::slice::from_raw_parts(slot.add(FRAME_HEADER_BYTES), 4 * 2 * 3 / 2);
            // Luma rows 0..4 and 8..12, then the chroma row 16..20, tightly packed.
            assert_eq!(frame, &[0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19]);
        }
        assert!(
            VideoQueue::create(spec).is_err(),
            "a second writer must be refused"
        );
    }
}
