// The export templates. Each one is a port of the Python renderer in "Media Templates/render.py":
// same geometry, timing and type scale, drawn onto a 1080x1920 canvas one frame at a time.

import { FPS, makeCanvas, albumItems, Clip } from './media.js';

export const W = 1080, H = 1920;
const FAMILY = '"Cossette Texte"';
const fontPx = (s) => `${s}px ${FAMILY}`;

function fitSize(g, text, maxW, start = 400) {
  let s = start;
  g.font = fontPx(s);
  while (s > 8 && g.measureText(text).width > maxW) { s -= 2; g.font = fontPx(s); }
  return s;
}

function cycle(items, n) {
  return Array.from({ length: n }, (_, i) => items[i % items.length]);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lc = (on, s) => (on ? s.toLowerCase() : s);
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

// ---------------------------------------------------------------- text defaults from the show info

function withLines(people) {
  if (!people.length) return [];
  if (people.length === 1) return ['with ' + people[0]];
  return ['with ' + people[0], ...people.slice(1, -1), 'and ' + people[people.length - 1]];
}

const infoDefaults = (show) => ({
  lines: [show.artist, show.city, show.venue, ...withLines(show.people)].filter(Boolean).join('\n'),
});

// ---------------------------------------------------------------- stacked export

async function prepareStacked(env) {
  const per = 0.2, dur = 7, nfPer = Math.round(per * FPS), nCards = Math.round(dur / per);
  const cards = cycle(albumItems(env.album, per, env.excluded), nCards).map((c) => (c.kind === 'clip' ? c.copy() : c));
  const cw = 880, ch = 1550, cx = 518, cy = 945;
  const rnd = mulberry32(7);
  const poses = cards.map(() => [rnd() * 3.2 - 1.6, Math.floor(rnd() * 36) - 14, Math.floor(rnd() * 30) - 16]);
  poses[0] = [0.6, 0, 0];

  const overlay = makeCanvas(W, H);
  const o = overlay.getContext('2d');
  o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'alphabetic';
  const ref = fitSize(o, 'omar apollo', 582);            // reference type scale
  const title = lc(env.lowercase, env.text.title || '');
  const ts = Math.min(ref, fitSize(o, title, 940));
  o.font = fontPx(ts); o.fillText(title, W / 2, 932);
  lines(env.text.subtitle).forEach((l, i) => {
    l = lc(env.lowercase, l);
    const s = Math.min(Math.round(ref * 0.47), fitSize(o, l, 900));
    o.font = fontPx(s); o.fillText(l, W / 2, 1045 + i * 60);
  });

  const base = makeCanvas(W, H);
  const b = base.getContext('2d');
  let baseCount = -1;
  const resetBase = () => { b.fillStyle = '#000'; b.fillRect(0, 0, W, H); baseCount = 0; };

  function place(g, im, [ang, dx, dy]) {
    g.save();
    g.translate(cx + dx, cy + dy);
    g.rotate(-ang * Math.PI / 180);
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, -cw / 2, -ch / 2, cw, ch);
    g.fillStyle = 'rgba(0,0,0,0.14)';                    // cards sit ~14% darker so the type reads
    g.fillRect(-cw / 2, -ch / 2, cw, ch);
    g.restore();
  }

  return {
    frames: Math.round(dur * FPS),
    async draw(g, i) {
      const k = Math.min(Math.floor(i / nfPer), nCards - 1), f = i - k * nfPer;
      if (baseCount < 0 || baseCount > k) resetBase();
      while (baseCount < k) {                            // earlier cards become part of the pile
        place(b, await cards[baseCount].frame(cw, ch, (nfPer - 1) / FPS), poses[baseCount]);
        cards[baseCount].close();                        // its last frame now lives in the pile
        baseCount++;
      }
      g.drawImage(base, 0, 0);
      place(g, await cards[k].frame(cw, ch, f / FPS), poses[k]);
      g.drawImage(overlay, 0, 0);
    },
    dispose() { cards.forEach((c) => c.close()); },
  };
}

// ---------------------------------------------------------------- info spread (+ mixed variant)

async function prepareInfo(env, mixed) {
  const swap = 0.8;
  let nSwaps = 21, nf = Math.round(swap * FPS);
  const L_ = lines(env.text.lines).map((s) => lc(env.lowercase, s));
  const items = albumItems(env.album, swap, env.excluded);
  const bg = env.background || env.album.photos[0] || items[0];

  const t = makeCanvas(W, H);
  const d = t.getContext('2d');
  const ref = fitSize(d, 'omar apollo', 600);
  const lineW = (s, size) => {
    const k = size / 120; d.font = fontPx(size);
    return d.measureText(s + ' (').width + 16 * k + 186 * k + 16 * k + d.measureText(')').width;
  };
  let size = ref;
  while (L_.length && Math.max(...L_.map((s) => lineW(s, size))) > 1000 && size > 30) size -= 2;
  const k = size / 120;
  const tw = Math.round(186 * k), th = Math.round(124 * k);
  const pitch = Math.round(230 * k);
  const first = 960 + Math.round(-(L_.length - 1) / 2 * pitch) + Math.round(40 * k);
  d.font = fontPx(size); d.fillStyle = '#fff'; d.textBaseline = 'alphabetic'; d.textAlign = 'left';
  const slots = L_.map((s, i) => {
    const y = first + i * pitch;
    const x0 = (W - lineW(s, size)) / 2;
    d.font = fontPx(size);
    const left = s + ' (';
    d.fillText(left, x0, y);
    const tx = x0 + d.measureText(left).width + 16 * k;
    d.fillText(')', tx + tw + 16 * k, y);
    const m = d.measureText('(');
    return [Math.round(tx), Math.round(y - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 - th / 2)];
  });

  // dimmed background + fade to near-black toward the bottom
  const back = makeCanvas(W, H);
  const bk = back.getContext('2d');
  const bgFrameStill = bg && bg.kind === 'photo';
  async function drawBack(g, tt) {
    if (bg) g.drawImage(await bg.frame(W, H, tt), 0, 0); else { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    g.fillStyle = 'rgba(0,0,0,0.38)'; g.fillRect(0, 0, W, H);
    for (let y = 1150; y < H; y += 2) {
      const a = Math.pow(Math.min(1, (y - 1150) / 770), 1.3) * 235 / 255;
      g.fillStyle = `rgba(2,2,14,${a.toFixed(3)})`; g.fillRect(0, y, W, 2);
    }
  }
  if (bgFrameStill) await drawBack(bk, 0);

  const L = L_.length, N = items.length, step = Math.max(1, Math.floor(N / Math.max(1, L)));
  let chosenFor = (c) => L_.map((_, i) => items[(c + i * step) % N]);
  const owned = [];

  if (mixed) {
    // odd lines hold one photo the whole time; the rest each play a different video straight through
    const staticIdx = L_.map((_, i) => i).filter((i) => i % 2 === 0);
    let photos = items.filter((m) => m.kind === 'photo' && m !== bg);
    if (!photos.length) photos = items.filter((m) => m.kind === 'photo');
    if (!photos.length) photos = items;
    const pick = new Map(staticIdx.map((li, j) => [li, photos[photos.length > 1 && staticIdx.length > 1
      ? Math.round(j * (photos.length - 1) / (staticIdx.length - 1)) : 0]]));
    const moving = L_.map((_, i) => i).filter((i) => !pick.has(i));
    const srcs = env.album.videos.filter((v) => !env.excluded.has(v.id));
    const clips = moving.map((_, j) => (srcs.length ? new Clip(srcs[j % srcs.length], 0, srcs[j % srcs.length].duration - 0.05)
      : items[j % items.length]));
    owned.push(...clips.filter((c) => c.kind === 'clip'));
    const fixed = L_.map((_, i) => (pick.has(i) ? pick.get(i) : clips[moving.indexOf(i)]));
    chosenFor = () => fixed;
    nSwaps = 1; nf = Math.round(30 * FPS);
  }

  return {
    frames: nSwaps * nf,
    async draw(g, i) {
      const c = Math.floor(i / nf), fi = i - c * nf;
      if (bgFrameStill) g.drawImage(back, 0, 0); else await drawBack(g, i / FPS);
      if (N) {
        const chosen = chosenFor(c);
        for (let j = 0; j < slots.length; j++) {
          const it = chosen[j];
          let lt = fi / FPS;
          if (it.kind === 'clip' && lt > it.dur) lt %= it.dur;   // loop clips shorter than the export
          g.drawImage(await it.frame(tw, th, lt), slots[j][0], slots[j][1]);
        }
      }
      g.drawImage(t, 0, 0);
    },
    dispose() { items.forEach((m) => m.close()); owned.forEach((m) => m.close()); },
  };
}

// ---------------------------------------------------------------- wheel spread

// card geometry at integer slot positions (0 = centre, 1 below, ...): top y, bottom y, top width, bottom width
const SLOTS = [[-320, 320, 360, 360], [370, 767, 476, 390], [785, 828, 376, 320], [842, 842, 300, 280]];

function slotGeom(p) {
  const a = Math.abs(p);
  if (a >= 3) return null;
  const i = Math.floor(a), fr = a - i;
  let [top, bot, tw, bw] = SLOTS[i].map((v, j) => v + (SLOTS[i + 1][j] - v) * fr);
  if (p < 0) [top, bot, tw, bw] = [-bot, -top, bw, tw];
  return bot - top < 2 ? null : [top, bot, tw, bw];
}

/** Draw `tex` into an isosceles trapezoid with perspective-correct vertical mapping (strip by strip). */
function drawTrapezoid(g, tex, cx, top, bot, tw, bw) {
  const A = tw, B = bw, band = 2;
  const vAt = (y) => (A * (top - y)) / (y * (B - A) - B * bot + A * top);
  for (let y = top; y < bot; y += band) {
    const y1 = Math.min(bot, y + band);
    const v0 = vAt(y), v1 = vAt(y1);
    const w = A + (B - A) * ((y + y1) / 2 - top) / (bot - top);
    const sy = v0 * tex.height, sh = Math.max(0.5, (v1 - v0) * tex.height);
    g.drawImage(tex, 0, sy, tex.width, sh, cx - w / 2, y, w, y1 - y + 0.6);
  }
}

async function prepareWheel(env) {
  const dur = 21, hold = 1.0, move = 0.4, period = hold + move;
  const nSteps = Math.round(dur / period), nCards = nSteps + 6;
  const cards = cycle(albumItems(env.album, 4.0, env.excluded), nCards).map((c) => (c.kind === 'clip' ? c.copy() : c));
  const tex = [480, 854], cx = W / 2, cy = H / 2;

  const t = makeCanvas(W, H);
  const d = t.getContext('2d');
  const left = lines(env.text.left).map((s) => lc(env.lowercase, s));
  const right = lines(env.text.right).map((s) => lc(env.lowercase, s));
  const size = Math.min(46, ...[...left, ...right].map((s) => fitSize(d, s, 272, 120)));
  const lh = Math.round(size * 1.25);
  d.font = fontPx(size); d.fillStyle = 'rgb(24,24,24)'; d.textBaseline = 'alphabetic';
  [[left, 330, 'right'], [right, 750, 'left']].forEach(([col, x, align]) => {
    d.textAlign = align;
    const y0 = cy - (col.length - 1) * lh / 2 + size * 0.36;
    col.forEach((s, i) => d.fillText(s, x, y0 + i * lh));
  });

  return {
    frames: Math.round(dur * FPS),
    async draw(g, fi) {
      const tt = fi / FPS;
      const stepi = Math.floor(tt / period), ph = tt - stepi * period;
      const scroll = stepi + (ph > hold ? ease((ph - hold) / move) : 0);
      g.fillStyle = 'rgb(245,245,240)'; g.fillRect(0, 0, W, H);
      const vis = [];
      for (let k = 0; k < nCards; k++) {
        const p = k - scroll - 2, geo = slotGeom(p);
        if (geo) vis.push([Math.abs(p), k, geo]);
        else if (p <= -3) cards[k].close();              // gone over the top

      }
      vis.sort((a, b) => b[0] - a[0]);                   // centre card drawn last (on top)
      g.imageSmoothingQuality = 'high';
      for (const [, k, [top, bot, tw, bw]] of vis) {
        const enter = (k - 5) * period;                  // clips start when the card enters the wheel
        const img = await cards[k].frame(tex[0], tex[1], Math.max(0, tt - enter));
        drawTrapezoid(g, img, cx, cy + top, cy + bot, tw, bw);
      }
      g.drawImage(t, 0, 0);
    },
    dispose() { cards.forEach((c) => c.close()); },
  };
}

// ---------------------------------------------------------------- registry

export const TEMPLATES = [
  {
    id: 'stacked', name: 'stacked export', file: 'stacked-export', blurb: 'cards pile up on black', seconds: 7,
    defaults: (s) => ({ title: s.artist, subtitle: [s.date, s.venue].filter(Boolean).join('\n') }),
    prepare: prepareStacked,
  },
  {
    id: 'info-mixed', name: 'info spread, mixed', file: 'info-spread-mixed', blurb: 'half still photos, half playing videos', seconds: 30,
    defaults: infoDefaults,
    prepare: (env) => prepareInfo(env, true),
  },
  {
    id: 'wheel', name: 'wheel spread', file: 'wheel-spread', blurb: 'a turning wheel of cards', seconds: 21,
    defaults: (s) => ({ left: [s.artist, s.venue].filter(Boolean).join('\n'), right: [s.city, s.date].filter(Boolean).join('\n') }),
    prepare: prepareWheel,
  },
];
