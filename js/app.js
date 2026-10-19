import { loadAlbum, filesFromDrop, isPhoto, isVideo, makeCanvas, FPS } from './media.js';
import { TEMPLATES, W, H } from './templates.js';
import { encodeVideo, canEncode, whyCantEncode } from './encoder.js';

const $ = (s) => document.querySelector(s);
const STORE = 'cve:v2';
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

// sample words shown as placeholders
const PLACEHOLDERS = {
  title: 'artist', subtitle: 'date\nvenue',
  lines: 'artist\ncity\nvenue\nwith a friend\nand another',
  left: 'artist\nvenue', right: 'city\ndate',
};

const state = {
  step: 0,
  album: null,
  albumStamp: 0,
  template: 'stacked',
  text: {},             // template id -> {field: value}
  blob: null,
  fileName: '',
};

try {
  const s = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (s) { state.text = s.text || {}; if (TEMPLATES.some((t) => t.id === s.template)) state.template = s.template; }
} catch { /* storage unavailable */ }
for (const t of TEMPLATES) {
  state.text[t.id] ??= {};
  for (const f of t.fields) state.text[t.id][f.key] ??= '';
}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ template: state.template, text: state.text })); } catch {} };

const tpl = () => TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
const env = (id = state.template) => ({
  album: state.album, excluded: new Set(), text: state.text[id], lowercase: true, background: null,
});

// ---------------------------------------------------------------- screens

const SCREENS = [
  { title: 'add your media', sub: () => (state.album ? summary() : 'a folder from the show, or just the photos and videos you want.') },
  { title: 'choose a template', sub: () => 'tap one, then add the words.' },
  { title: 'render video', sub: () => `${tpl().name} · ${tpl().seconds}s video.` },
  { title: 'your video', sub: () => (state.blob ? `${tpl().name} · ${(state.blob.size / 1e6).toFixed(1)} mb` : '') },
];

const summary = () => {
  const p = state.album.photos.length, v = state.album.videos.length;
  return `${p} photo${p === 1 ? '' : 's'} · ${v} video${v === 1 ? '' : 's'} ready.`;
};

const canReach = (i) => i === 0 || (i <= 2 && !!state.album) || (i === 3 && !!state.blob);

function go(i) {
  if (!canReach(i) || rendering) return;
  state.step = i;
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = +s.dataset.screen !== i; });
  if (i === 1) renderCards();
  if (i === 2) { statusMsg = ''; schedulePreview(); }
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
  $('#count').textContent = `${i + 1} / 4`;
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
  } else if (i === 3) {
    acts.style.gridTemplateColumns = '';
    acts.append(heroButton('export video', 'btn-solid', exportVideo),
      heroButton('another template ↗', 'btn-ghost', () => go(1)));
  }
  $('#drop').hidden = MOBILE;

  const left = $('#dock-left'), right = $('#dock-right');
  left.classList.toggle('invisible', i === 0 && !rendering);
  left.textContent = rendering ? 'cancel' : 'back';
  left.disabled = false;
  right.disabled = false;
  if (i === 0) { right.textContent = 'next'; right.disabled = !state.album; }
  if (i === 1) right.textContent = 'next';
  if (i === 2) { right.textContent = rendering ? `${renderPct}%` : 'render'; right.disabled = rendering || !canEncode(); }
  if (i === 3) right.textContent = 'export';
  if (i === 2) paintStatus();
}

$('#back').addEventListener('click', () => go(state.step - 1));
$('#dock-left').addEventListener('click', () => (rendering ? abort?.abort() : go(state.step - 1)));
$('#dock-right').addEventListener('click', () => {
  if (state.step < 2) go(state.step + 1);
  else if (state.step === 2) render();
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
      ? `skipped ${album.failed.length}: ${album.failed.map((f) => f.name).join(', ')}`
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

// ---------------------------------------------------------------- 2 · template

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
        state.template = t.id; state.blob = null; save(); renderWords(); paint();
      });
      box.appendChild(lab);
    }
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = i.value === state.template; });
  box.querySelectorAll('video').forEach((v) => v.play().catch(() => {}));
  renderWords();
}

function renderWords() {
  const t = tpl();
  const box = $('#words');
  box.innerHTML = '';
  for (const f of t.fields) {
    // one input per line: each placeholder line is its own field, stored back as one line each
    const names = (PLACEHOLDERS[f.key] || f.label).split('\n');
    const vals = (state.text[t.id][f.key] || '').split('\n');
    const group = document.createElement('fieldset');
    if (t.fields.length > 1) group.innerHTML = `<legend>${f.label}</legend>`;
    const inputs = [];
    for (let i = 0; i < Math.max(names.length, vals.length); i++) {
      const lab = document.createElement('label');
      lab.innerHTML = `<span>${names[i] || 'more'}</span>`;
      const el = document.createElement('input');
      el.value = vals[i] || '';
      el.placeholder = names[i] || '';
      el.autocapitalize = 'none';
      el.spellcheck = false;
      el.addEventListener('input', () => {
        state.text[t.id][f.key] = inputs.map((x) => x.value).join('\n').replace(/\n+$/, '');
        state.blob = null;
        save();
      });
      inputs.push(el);
      lab.appendChild(el);
      group.appendChild(lab);
    }
    box.appendChild(group);
  }
}

// ---------------------------------------------------------------- 3 · render

const work = makeCanvas(W, H);
const view = $('#preview');
let prepared = null, preparedKey = '';
let wantFrame = 0, drawing = false, rendering = false, abort = null;
let renderPct = 0, statusMsg = '';

const configKey = () => JSON.stringify([state.template, state.text[state.template], state.albumStamp]);
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

new ResizeObserver(() => { if (state.step === 2 && !drawing && !rendering) showFrame(); }).observe(view);


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
    const first = (state.text[t.id].title || state.text[t.id].lines || state.text[t.id].left || '').split('\n').find(Boolean);
    state.blob = blob;
    state.fileName = `${slug(first) || 'concert'}_${t.file}_9x16.mp4`;
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

// ---------------------------------------------------------------- 4 · export

let resultUrl = null;
function showResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(state.blob);
  $('#result').src = resultUrl;
  $('#export-note').textContent = MOBILE ? 'export opens the share sheet — choose “save video” to put it in your photos.' : state.fileName;
  go(3);
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
