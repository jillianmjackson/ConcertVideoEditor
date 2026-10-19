import { loadAlbum, filesFromDrop, isPhoto, isVideo, makeCanvas, FPS } from './media.js';
import { TEMPLATES, W, H } from './templates.js';
import { encodeVideo, canEncode, whyCantEncode } from './encoder.js';

const $ = (s) => document.querySelector(s);
const STORE = 'cve:v3';
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

// the event info, asked once and used by every template
const EVENT_FIELDS = [
  { key: 'artist', label: 'artist', placeholder: 'who did you see?' },
  { key: 'venue', label: 'venue', placeholder: 'where was it?' },
  { key: 'city', label: 'city', placeholder: 'city' },
  { key: 'date', label: 'date', placeholder: 'mar 29th 2024' },
  { key: 'friend1', label: 'who you went with', placeholder: 'a friend' },
  { key: 'friend2', label: '', placeholder: 'another friend' },
  { key: 'friend3', label: '', placeholder: 'and another' },
];

const state = {
  step: 0,
  album: null,
  albumStamp: 0,
  template: 'stacked',
  event: Object.fromEntries(EVENT_FIELDS.map((f) => [f.key, ''])),
  blob: null,
  fileName: '',
};

try {
  const s = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (s) {
    Object.assign(state.event, s.event || {});
    if (TEMPLATES.some((t) => t.id === s.template)) state.template = s.template;
  }
} catch { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ template: state.template, event: state.event })); } catch {} };

const tpl = () => TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
const show = () => {
  const e = Object.fromEntries(Object.entries(state.event).map(([k, v]) => [k, v.trim()]));
  return { ...e, people: [e.friend1, e.friend2, e.friend3].filter(Boolean) };
};
const env = (id = state.template) => ({
  album: state.album, excluded: new Set(), text: TEMPLATES.find((t) => t.id === id).defaults(show()), lowercase: true, background: null,
});

// ---------------------------------------------------------------- screens

const SCREENS = [
  { title: 'add your media', sub: () => (state.album ? summary() : 'a folder from the show, or just the photos and videos you want.') },
  { title: 'a bit about your event', sub: () => 'this goes on every template. leave anything blank to skip it.' },
  { title: 'choose a template', sub: () => 'tap one to pick it.' },
  { title: 'render video', sub: () => `${tpl().name} · ${tpl().seconds}s video.` },
  { title: 'your video', sub: () => (state.blob ? `${tpl().name} · ${(state.blob.size / 1e6).toFixed(1)} mb` : '') },
];

const summary = () => {
  const p = state.album.photos.length, v = state.album.videos.length;
  return `${p} photo${p === 1 ? '' : 's'} · ${v} video${v === 1 ? '' : 's'} ready.`;
};

const canReach = (i) => i === 0 || (i <= 3 && !!state.album) || (i === 4 && !!state.blob);
const RENDER = 3, EXPORT = 4;

function go(i) {
  if (!canReach(i) || rendering) return;
  state.step = i;
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = +s.dataset.screen !== i; });
  if (i === 1) renderEvent();
  if (i === 2) renderCards();
  if (i === RENDER) { statusMsg = ''; schedulePreview(); }
  paint();
  window.scrollTo({ top: 0 });
}

function heroButton(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `btn ${cls}`; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function paint() {
  const i = state.step, sc = SCREENS[i];
  $('#title').textContent = sc.title;
  $('#sub').textContent = sc.sub();
  $('#count').textContent = `${i + 1} / ${SCREENS.length}`;
  $('#dock-dot').textContent = String(i + 1);
  $('#back').disabled = i === 0 || rendering;

  document.querySelectorAll('.pills .pill').forEach((p) => {
    const n = +p.dataset.step;
    p.disabled = !canReach(n) || rendering;
    if (n === i) p.setAttribute('aria-current', 'step'); else p.removeAttribute('aria-current');
  });

  const acts = $('#hero-actions');
  acts.innerHTML = '';
  if (i === 0) {
    if (MOBILE) {
      acts.append(heroButton('choose photos & videos', 'btn-solid', () => $('#pick-files').click()));
      acts.style.gridTemplateColumns = '1fr';
    } else {
      acts.style.gridTemplateColumns = '';
      acts.append(heroButton('upload folder', 'btn-solid', () => $('#pick-folder').click()),
        heroButton('select images', 'btn-ghost', () => $('#pick-files').click()));
    }
  } else if (i === EXPORT) {
    acts.style.gridTemplateColumns = '';
    acts.append(heroButton('export video', 'btn-solid', exportVideo),
      heroButton('another template ↗', 'btn-ghost', () => go(2)));
  }
  $('#drop').hidden = MOBILE;

  const left = $('#dock-left'), right = $('#dock-right');
  left.classList.toggle('invisible', i === 0 && !rendering);
  left.textContent = rendering ? 'cancel' : 'back';
  left.disabled = false;
  right.disabled = false;
  if (i === 0) { right.textContent = 'next'; right.disabled = !state.album; }
  if (i === 1 || i === 2) right.textContent = 'next';
  if (i === RENDER) { right.textContent = rendering ? `${renderPct}%` : 'render'; right.disabled = rendering || !canEncode(); }
  if (i === EXPORT) right.textContent = 'export';
  if (i === RENDER) paintStatus();
}

$('#back').addEventListener('click', () => go(state.step - 1));
$('#dock-left').addEventListener('click', () => (rendering ? abort?.abort() : go(state.step - 1)));
$('#dock-right').addEventListener('click', () => {
  if (state.step < RENDER) go(state.step + 1);
  else if (state.step === RENDER) render();
  else exportVideo();
});
document.querySelectorAll('.pills .pill').forEach((p) => p.addEventListener('click', () => go(+p.dataset.step)));

// ---------------------------------------------------------------- 1 · upload

async function takeFiles(files) {
  files = files.filter((f) => (isPhoto(f) || isVideo(f)) && !f.name.startsWith('.'));
  if (!files.length) { $('#upload-status').textContent = 'no photos or videos in there — try again?'; return; }
  disposePreview();
  state.album = null;
  state.blob = null;
  $('#tiles').innerHTML = '';
  paint();
  try {
    const album = await loadAlbum(files, (d, n) => {
      $('#upload-status').textContent = `reading ${Math.min(d + 1, n)} of ${n}…`;
    });
    if (!album.photos.length && !album.videos.length) throw new Error("couldn't read any of those files");
    state.album = album;
    state.albumStamp++;
    $('#upload-status').textContent = album.failed.length
      ? `skipped ${album.failed.length}: ${album.failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`
      : 'photos and videos stay on your device.';
    const all = [...album.photos, ...album.videos].sort((a, b) => a.taken - b.taken);
    $('#tiles').innerHTML = all.map((m) => {
      const s = Math.round(m.duration || 0);
      return `<div class="tile"><img alt="" src="${m.thumb || ''}">${m.kind === 'video' ? `<span>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>` : ''}</div>`;
    }).join('');
  } catch (e) {
    $('#upload-status').textContent = 'something went wrong: ' + e.message;
  }
  paint();
}

for (const id of ['#pick-folder', '#pick-files']) {
  $(id).addEventListener('change', (e) => { takeFiles([...e.target.files]); e.target.value = ''; });
}
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => { e.preventDefault(); takeFiles(await filesFromDrop(e.dataTransfer)); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------- 2 · event

function renderEvent() {
  const form = $('#event');
  if (form.children.length) return;
  for (const f of EVENT_FIELDS) {
    const lab = document.createElement('label');
    if (f.label) lab.innerHTML = `<span>${f.label}</span>`;
    else lab.classList.add('more');
    const el = document.createElement('input');
    el.name = f.key;
    el.value = state.event[f.key];
    el.placeholder = f.placeholder;
    el.setAttribute('aria-label', f.label || f.placeholder);
    el.autocapitalize = 'none';
    el.spellcheck = false;
    el.enterKeyHint = 'next';
    el.addEventListener('input', () => { state.event[f.key] = el.value; state.blob = null; save(); });
    lab.appendChild(el);
    form.appendChild(lab);
  }
  // return moves to the next field, and from the last one on to templates
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const ins = [...form.querySelectorAll('input')], k = ins.indexOf(e.target);
    if (k >= 0 && k < ins.length - 1) ins[k + 1].focus(); else { e.target.blur(); go(2); }
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- 3 · template

function renderCards() {
  const box = $('#cards');
  if (!box.children.length) {
    for (const t of TEMPLATES) {
      const lab = document.createElement('label');
      lab.className = 'card';
      lab.dataset.id = t.id;
      lab.innerHTML = `<input type="radio" name="template" value="${t.id}">
        <span class="card-media">
          <video src="previews/${t.id}.mp4" poster="previews/${t.id}.jpg" muted loop playsinline autoplay preload="metadata" aria-hidden="true"></video>
          <span class="card-tick">selected</span>
        </span>
        <span class="card-label"><b>${t.name}</b><span>${t.blurb} · ${t.seconds}s</span></span>`;
      lab.querySelector('input').addEventListener('change', () => {
        state.template = t.id; state.blob = null; save(); paint();
      });
      box.appendChild(lab);
    }
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = i.value === state.template; });
  box.querySelectorAll('video').forEach((v) => v.play().catch(() => {}));
}

// ---------------------------------------------------------------- 4 · render

const work = makeCanvas(W, H);
const view = $('#preview');
let prepared = null, preparedKey = '';
let wantFrame = 0, drawing = false, rendering = false, abort = null;
let renderPct = 0, statusMsg = '';

const configKey = () => JSON.stringify([state.template, state.event, state.albumStamp]);
function disposePreview() { prepared?.dispose(); prepared = null; preparedKey = ''; }

async function getPrepared() {
  if (!prepared || preparedKey !== configKey()) {
    disposePreview();
    await document.fonts.load('100px "Cossette Texte"');
    prepared = await tpl().prepare(env());
    preparedKey = configKey();
    wantFrame = Math.min(prepared.frames - 1, FPS * 2);   // a still from 2s in
  }
  return prepared;
}

function showFrame(src = work) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(180, Math.round(view.getBoundingClientRect().width * dpr)), h = Math.round(w * 16 / 9);
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  const g = view.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
}

async function drawPreview() {
  if (drawing || !state.album || rendering) return;
  drawing = true;
  try {
    let done = -1, doneKey = '';
    while (done !== wantFrame || doneKey !== configKey()) {
      const f = wantFrame, key = configKey();
      const p = await getPrepared();
      await p.draw(work.getContext('2d'), Math.min(f, p.frames - 1));
      showFrame();
      done = f; doneKey = key;
    }
  } catch (e) {
    statusMsg = "couldn't draw the preview: " + e.message;
    paintStatus();
  } finally {
    drawing = false;
  }
}

let previewTimer = 0;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 60); }

new ResizeObserver(() => { if (state.step === RENDER && !drawing && !rendering) showFrame(); }).observe(view);


// the status bar: always says what's happening, or why rendering can't start
function paintStatus(left = '') {
  const why = whyCantEncode();
  let head, sub, pct = '';
  if (rendering) {
    head = renderPct ? 'rendering…' : 'getting ready…';
    pct = `${renderPct}%`;
    sub = (left ? `about ${left} left. ` : '') + 'keep this page open and your screen on.';
  } else if (statusMsg) {
    head = statusMsg; sub = why || 'tap render to try again.';
  } else if (why) {
    head = "can't render here"; sub = why;
  } else {
    head = 'ready to render'; sub = 'tap render. it can take a minute or two on a phone.';
  }
  $('#render-status').textContent = head;
  $('#pct').textContent = pct;
  $('#render-sub').textContent = sub;
  $('#bar').style.width = (rendering ? renderPct : 0) + '%';
  $('#progress').setAttribute('aria-valuenow', String(rendering ? renderPct : 0));
  $('#progress').classList.toggle('is-blocked', !rendering && !!why);
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-');

async function render() {
  rendering = true;
  renderPct = 0;
  statusMsg = '';
  abort = new AbortController();
  paint();
  const t = tpl();
  let job = null, lock = null;
  const started = performance.now();
  try {
    lock = await navigator.wakeLock?.request('screen').catch(() => null);   // a sleeping screen stops the render
    await document.fonts.load('100px "Cossette Texte"');
    disposePreview();                               // free the preview's videos while rendering
    job = await t.prepare(env());
    const canvas = makeCanvas(W, H);
    const blob = await encodeVideo({
      canvas, frames: job.frames, signal: abort.signal,
      draw: (g, i) => job.draw(g, i),
      onFrame: (i, n) => {
        const pct = Math.floor(100 * i / n);
        if (pct === renderPct && i % 15) return;
        renderPct = pct;
        const s = (performance.now() - started) / 1000 / i * (n - i);
        paintStatus(i > 10 ? (s < 60 ? Math.ceil(s) + 's' : Math.ceil(s / 60) + ' min') : '');
        $('#dock-right').textContent = `${pct}%`;
        if (i % 15 === 0) showFrame(canvas);
      },
    });
    const name = [show().artist, show().venue].filter(Boolean).join(' ');
    state.blob = blob;
    state.fileName = `${slug(name) || 'concert'}_${t.file}_9x16.mp4`;
    rendering = false;
    showResult();
  } catch (e) {
    statusMsg = e.name === 'AbortError' ? 'cancelled.' : 'something went wrong: ' + e.message;
  } finally {
    job?.dispose();
    lock?.release().catch(() => {});
    rendering = false;
    abort = null;
    paint();
  }
}

// ---------------------------------------------------------------- 5 · export

let resultUrl = null;
function showResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(state.blob);
  $('#result').src = resultUrl;
  $('#export-note').textContent = MOBILE ? 'export opens the share sheet — choose “save video” to put it in your photos.' : state.fileName;
  go(EXPORT);
  $('#result').play().catch(() => {});
}

async function exportVideo() {
  if (!state.blob) return;
  const file = new File([state.blob], state.fileName, { type: 'video/mp4' });
  if (MOBILE && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }    // share sheet closed
  }
  const a = $('#download');
  a.href = resultUrl;
  a.download = state.fileName;
  a.click();
}

// ---------------------------------------------------------------- boot

go(0);
window.addEventListener('load', paint);   // mp4-muxer loads with `defer`
