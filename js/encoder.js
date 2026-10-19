// Frame-by-frame H.264 encoding in the browser (WebCodecs) muxed to .mp4 (mp4-muxer).

import { FPS } from './media.js?v=7';

export const canEncode = () => !whyCantEncode();

// null when this browser can make videos, otherwise a short reason for the person
export function whyCantEncode() {
  if (typeof window.VideoEncoder !== 'function' || typeof window.VideoFrame !== 'function') {
    return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && !/CriOS|FxiOS|Chrome/.test(navigator.userAgent)
      ? "this phone's browser can't make videos yet. update to ios 16.4 or newer, then try again."
      : "this browser can't make videos. try the latest chrome, edge or safari.";
  }
  if (!window.Mp4Muxer) return "the video tools didn't load. check your connection and reload the page.";
  return null;
}

async function pickConfig(width, height) {
  // High / Main / Baseline at level 5.1, then 4.2 — whichever this device's encoder accepts
  for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.420033', 'avc1.64002a', 'avc1.42002a']) {
    const cfg = { codec, width, height, bitrate: 12_000_000, framerate: FPS, avc: { format: 'avc' } };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return cfg;
    } catch { /* try the next one */ }
  }
  throw new Error('this browser can\'t encode 1080×1920 h.264 video');
}

/**
 * Render `frames` frames with `draw(ctx, i)` onto `canvas` and encode them.
 * Returns an mp4 Blob. `signal` (AbortSignal) cancels.
 */
export async function encodeVideo({ canvas, frames, draw, onFrame = () => {}, signal }) {
  const { width, height } = canvas;
  const config = await pickConfig(width, height);
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: FPS },
    fastStart: 'in-memory',
  });
  let failure = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  enc.configure(config);
  const g = canvas.getContext('2d');
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (failure) throw failure;
      await draw(g, i);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      onFrame(i + 1, frames);
    }
    await enc.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
}
