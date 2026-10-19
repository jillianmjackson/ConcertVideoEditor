// Album loading: photos + videos from a folder or file picker, capture-time ordering,
// and clip "quality" analysis so dark / blurry stretches of phone video are skipped.

export const FPS = 30;
const PHOTO_RE = /\.(jpe?g|png|webp|heic|heif|avif|gif)$/i;
const VIDEO_RE = /\.(mov|mp4|m4v|webm)$/i;
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
const MAX_DECODED = MOBILE ? 8 : 24;   // photos kept decoded at once (LRU) — phones have tight canvas memory
const PHOTO_MAX_EDGE = 1920;

export const isPhoto = (f) => PHOTO_RE.test(f.name) || f.type.startsWith('image/');
export const isVideo = (f) => VIDEO_RE.test(f.name) || f.type.startsWith('video/');
export const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /heic|heif/.test(f.type);

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Draw `src` (sw x sh) into the destination rect, cropped to fill it (like object-fit: cover). */
export function drawCover(ctx, src, sw, sh, dx, dy, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  const cw = dw / s, ch = dh / s;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, dx, dy, dw, dh);
}

// ---------------------------------------------------------------- photos

let heicLib = null;
async function loadHeicLib() {
  if (!heicLib) {
    heicLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      s.onload = () => res(window.heic2any);
      s.onerror = () => rej(new Error('could not load the heic converter'));
      document.head.appendChild(s);
    });
  }
  return heicLib;
}

// Decoded through an <img>: every current browser applies the camera's EXIF / HEIC rotation there,
// and drawing the <img> onto a canvas keeps it. (createImageBitmap's default differs between browsers.)
async function decodeBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.style.imageOrientation = 'from-image';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function decodeImage(file) {
  try {
    return await decodeBlob(file);
  } catch (e) {
    if (!isHeic(file)) throw e;
    const heic2any = await loadHeicLib();       // browsers without native HEIC (Chrome, Edge, Firefox); rotation is applied
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return decodeBlob(Array.isArray(out) ? out[0] : out);
  }
}

const decodedLRU = [];

export class Photo {
  constructor(file) {
    this.kind = 'photo';
    this.file = file;
    this.name = file.name;
    this.id = 'p:' + file.name + ':' + file.size;
    this.taken = file.lastModified;
    this.thumb = null;          // object URL for the UI
    this.brightness = 0;        // 0..255, used to pick a default background
    this.landscape = false;
    this._img = null;
    this._cache = new Map();
  }

  async image() {
    if (!this._img) {
      const img = await decodeImage(this.file);
      const iw = img.naturalWidth, ih = img.naturalHeight;     // already upright
      const s = Math.min(1, PHOTO_MAX_EDGE / Math.max(iw, ih));
      const c = makeCanvas(Math.round(iw * s), Math.round(ih * s));
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      this._img = c;
      decodedLRU.push(this);
      while (decodedLRU.length > MAX_DECODED) {
        const old = decodedLRU.shift();
        if (old !== this) { old._img = null; old._cache.clear(); }
      }
    }
    return this._img;
  }

  async frame(w, h) {
    const key = w + 'x' + h;
    let c = this._cache.get(key);
    if (!c) {
      const img = await this.image();
      c = makeCanvas(w, h);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      drawCover(g, img, img.width, img.height, 0, 0, w, h);
      this._cache.set(key, c);
    }
    return c;
  }

  close() {}
}

// ---------------------------------------------------------------- videos

function waitFor(el, ok, bad = 'error', ms = 30000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { done(); rej(new Error('it took too long to open')); }, ms);
    const onOk = () => { done(); res(); };
    const onBad = () => { done(); rej(new Error('this browser can\'t play that video')); };
    function done() { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener(bad, onBad); }
    el.addEventListener(ok, onOk);
    el.addEventListener(bad, onBad);
  });
}

// iOS Safari is much more willing to load and decode videos that are in the page,
// so working videos live in a tiny invisible box instead of floating detached.
let stash = null;
function videoStash() {
  if (!stash) {
    stash = document.createElement('div');
    stash.setAttribute('aria-hidden', 'true');
    stash.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(stash);
  }
  return stash;
}

export function closeVideo(v) {
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.remove();
}

export async function openVideo(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.style.cssText = 'width:2px;height:2px';
  videoStash().appendChild(v);
  v.src = url;
  try {
    if (v.readyState < 1) await waitFor(v, 'loadedmetadata');
    if (v.readyState < 2) {
      // iOS Safari ignores preload and won't decode a frame until the video has been played once
      const ready = waitFor(v, 'loadeddata');
      let played = false;
      try { await v.play(); v.pause(); played = true; } catch { /* refused, e.g. in low power mode */ }
      if (!played && v.readyState < 2) v.currentTime = 0.001;   // a seek also makes iOS decode a frame
      if (v.readyState < 2) await ready; else ready.catch(() => {});
    }
  } catch (e) {
    closeVideo(v);
    throw e;
  }
  return v;
}

export function seek(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return res();
    const to = setTimeout(done, 4000);
    function done() { clearTimeout(to); v.removeEventListener('seeked', done); res(); }
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

/** QuickTime / MP4 capture time from the `mvhd` box (seconds since 1904, UTC). */
async function movCreationTime(file) {
  let off = 0;
  for (let n = 0; n < 64 && off + 8 <= file.size; n++) {
    const hdr = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = hdr.getUint32(0);
    const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
    let head = 8;
    if (size === 1) { size = Number(hdr.getBigUint64(8)); head = 16; }
    else if (size === 0) size = file.size - off;
    if (type === 'moov') {
      const moov = new DataView(await file.slice(off + head, off + Math.min(size, 8 << 20)).arrayBuffer());
      for (let p = 0; p + 8 <= moov.byteLength;) {
        const s = moov.getUint32(p);
        const ty = String.fromCharCode(moov.getUint8(p + 4), moov.getUint8(p + 5), moov.getUint8(p + 6), moov.getUint8(p + 7));
        if (ty === 'mvhd') {
          const ver = moov.getUint8(p + 8);
          const secs = ver === 1 ? Number(moov.getBigUint64(p + 12)) : moov.getUint32(p + 12);
          if (secs > 0) return (secs - 2082844800) * 1000;
          return null;
        }
        if (s < 8) break;
        p += s;
      }
      return null;
    }
    if (size < 8) break;
    off += size;
  }
  return null;
}

export class VideoSource {
  constructor(file) {
    this.kind = 'video';
    this.file = file;
    this.name = file.name;
    this.id = 'v:' + file.name + ':' + file.size;
    this.url = URL.createObjectURL(file);
    this.taken = file.lastModified;
    this.duration = 0;
    this.thumb = null;
    this.quality = null;    // {bright[], sharp[], motion[], step}
  }

  async analyze(step = MOBILE ? 1 : 0.5) {
    const v = await openVideo(this.url);
    try { await this._measure(v, step); } finally { closeVideo(v); }
  }

  async _measure(v, step) {
    this.duration = v.duration;
    if (!Number.isFinite(this.duration) || this.duration <= 0) throw new Error("couldn't tell how long it is");
    const w = 72, h = 128;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    const bright = [], sharp = [], motion = [];
    let prev = null;
    const n = Math.max(1, Math.floor(this.duration / step));
    for (let i = 0; i < n; i++) {
      await seek(v, Math.min(i * step + 0.01, this.duration - 0.05));
      drawCover(g, v, v.videoWidth, v.videoHeight, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      const gray = new Float32Array(w * h);
      let sum = 0;
      for (let j = 0; j < w * h; j++) {
        const y = 0.299 * d[j * 4] + 0.587 * d[j * 4 + 1] + 0.114 * d[j * 4 + 2];
        gray[j] = y; sum += y;
      }
      let sh = 0, sv = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w - 1; xx++) sh += Math.abs(gray[yy * w + xx + 1] - gray[yy * w + xx]);
      for (let yy = 0; yy < h - 1; yy++) for (let xx = 0; xx < w; xx++) sv += Math.abs(gray[(yy + 1) * w + xx] - gray[yy * w + xx]);
      let mo = 0;
      if (prev) { for (let j = 0; j < w * h; j++) mo += Math.abs(gray[j] - prev[j]); mo /= w * h; }
      bright.push(sum / (w * h));
      sharp.push(sh / (h * (w - 1)) + sv / ((h - 1) * w));
      motion.push(mo);
      prev = gray;
      if (i === Math.min(2, n - 1) && !this.thumb) {   // a poster frame a little way in
        const t = makeCanvas(200, 200);
        drawCover(t.getContext('2d'), v, v.videoWidth, v.videoHeight, 0, 0, 200, 200);
        this.thumb = await new Promise((r) => t.toBlob((b) => r(URL.createObjectURL(b)), 'image/jpeg', 0.8));
      }
    }
    this.quality = { bright, sharp, motion, step };
  }
}

export class Clip {
  constructor(src, start, dur) {
    this.kind = 'clip';
    this.src = src;
    this.name = src.name;
    this.start = start;
    this.dur = dur;
    this.taken = src.taken + start * 1000;
    this._v = null;
    this._cache = new Map();   // size -> {t, canvas}
  }

  copy() { return new Clip(this.src, this.start, this.dur); }

  async frame(w, h, t = 0) {
    const time = Math.min(this.start + Math.min(Math.max(t, 0), this.dur), this.src.duration - 0.02);
    const key = w + 'x' + h;
    let e = this._cache.get(key);
    if (e && Math.abs(e.t - time) < 0.0005) return e.canvas;
    if (!this._v) this._v = await openVideo(this.src.url);
    await seek(this._v, time);
    if (!e) { e = { t: -1, canvas: makeCanvas(w, h) }; this._cache.set(key, e); }
    const g = e.canvas.getContext('2d');
    drawCover(g, this._v, this._v.videoWidth, this._v.videoHeight, 0, 0, w, h);
    e.t = time;
    return e.canvas;
  }

  close() {
    if (this._v) { closeVideo(this._v); this._v = null; }
    this._cache.clear();
  }
}

// ---------------------------------------------------------------- album

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Segments of `clipLen` seconds where the footage is bright enough, sharp, and not a whip-pan. */
export function goodSegments(src, clipLen) {
  const { bright, sharp, motion, step } = src.quality;
  const bLim = Math.max(22, percentile(bright, 25) * 0.8);
  const mLim = percentile(motion, 90) + 1e-6;
  const sLim = percentile(sharp, 20) * 0.9;
  const ok = bright.map((b, i) => b > bLim && motion[i] < mLim && sharp[i] > sLim);
  const need = Math.max(1, Math.ceil(clipLen / step - 1e-9));
  const segs = [];
  for (let i = 0; i + need <= ok.length;) {
    if (ok.slice(i, i + need).every(Boolean)) { segs.push(new Clip(src, i * step, clipLen)); i += need; }
    else i++;
  }
  if (!segs.length) {
    let best = 0, bi = 0;
    for (let i = 0; i + need <= bright.length; i++) {
      const s = bright.slice(i, i + need).reduce((a, b) => a + b, 0);
      if (s > best) { best = s; bi = i; }
    }
    segs.push(new Clip(src, bi * step, Math.min(clipLen, src.duration)));
  }
  return segs;
}

function exifDate(dt, offset) {
  // "2024:03:29 20:53:15" (+ optional "-04:00")
  const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(dt || ''));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${/^[+-]\d\d:\d\d$/.test(offset || '') ? offset : ''}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

async function photoTaken(file) {
  if (!window.exifr) return null;
  try {
    const x = await window.exifr.parse(file, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate'], reviveValues: false });
    return x ? exifDate(x.DateTimeOriginal || x.CreateDate, x.OffsetTimeOriginal) : null;
  } catch { return null; }
}

/** Load photos (thumb + brightness) and videos (duration, capture time, quality). */
export async function loadAlbum(files, onProgress = () => {}) {
  const photoFiles = files.filter((f) => isPhoto(f) && !isVideo(f));
  const videoFiles = files.filter(isVideo);
  const total = photoFiles.length + videoFiles.length;
  let done = 0;
  const photos = [], videos = [], failed = [];

  for (const f of photoFiles) {
    onProgress(done, total, f.name);
    const p = new Photo(f);
    try {
      p.taken = (await photoTaken(f)) ?? f.lastModified;
      const img = await p.image();
      const t = makeCanvas(200, 200);
      const g = t.getContext('2d', { willReadFrequently: true });
      drawCover(g, img, img.width, img.height, 0, 0, 200, 200);
      const d = g.getImageData(0, 0, 200, 200).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 16) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      p.brightness = s / (d.length / 16);
      p.landscape = img.width > img.height;
      p.thumb = await new Promise((r) => t.toBlob((b) => r(URL.createObjectURL(b)), 'image/jpeg', 0.8));
      photos.push(p);
    } catch (e) { failed.push({ name: f.name, reason: e.message }); }
    done++;
  }
  for (const f of videoFiles) {
    onProgress(done, total, f.name);
    const v = new VideoSource(f);
    try {
      v.taken = (await movCreationTime(f)) ?? f.lastModified;
      await v.analyze();
      videos.push(v);
    } catch (e) { failed.push({ name: f.name, reason: e.message }); }
    done++;
  }
  onProgress(total, total, '');
  return { photos, videos, failed };
}

/** Everything usable for a template, in capture order: photos + clip segments of `clipLen`. */
export function albumItems(album, clipLen, excluded = new Set()) {
  const items = [];
  for (const p of album.photos) if (!excluded.has(p.id)) items.push(p);
  for (const v of album.videos) if (!excluded.has(v.id)) items.push(...goodSegments(v, clipLen));
  items.sort((a, b) => (a.taken - b.taken) || ((a.start || 0) - (b.start || 0)));
  return items;
}

/** Recursively collect files from a drag-and-drop (folders included). */
export async function filesFromDrop(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}
