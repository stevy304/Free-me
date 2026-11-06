import type { Anim, Corner, Graphics, SceneDef, SourceId } from './model';

/** Draws one frame of the show on a 1280×720 canvas: background, the scene's layout, then the graphics on top. */
export const W = 1280;
export const H = 720;

export interface Inputs {
  camera: HTMLVideoElement | null;
  screen: HTMLVideoElement | null;
  media: HTMLVideoElement | HTMLImageElement | null;
  guests: HTMLVideoElement[];
}
/** Whether a graphic is on, and since when (performance.now() ms): its in or out animation runs from that moment. */
export interface Vis { on: boolean; at: number }
type Part = 'logo' | 'lower' | 'ticker' | 'clock';
/** When things appeared, for animations and countdowns. */
export interface Timing { sceneSince: number; logo: Vis; lower: Vis; ticker: Vis; clock: Vis }
const PARTS: Part[] = ['logo', 'lower', 'ticker', 'clock'];
export const newTiming = (now = performance.now()): Timing => ({ sceneSince: now, logo: { on: false, at: -1e9 }, lower: { on: false, at: -1e9 }, ticker: { on: false, at: -1e9 }, clock: { on: false, at: -1e9 } });
const shown = (g: Graphics): Record<Part, boolean> => ({
  logo: g.logo.show && !!g.logo.src, lower: g.lower.show && !!g.lower.name.trim(), ticker: g.ticker.show && !!g.ticker.text.trim(), clock: g.clock.show,
});
/**
 * Brings the animation clocks up to date with the graphics: a graphic that turns on starts its "in" animation, one
 * that turns off its "out" animation. `restart` replays a graphic's entrance (a new name on the lower third).
 */
export function syncTiming(t: Timing, g: Graphics, now = performance.now(), restart: Part[] = []) {
  const s = shown(g);
  for (const p of PARTS) if (s[p] !== t[p].on || (s[p] && restart.includes(p))) t[p] = { on: s[p], at: now };
}
export type Transition = 'cut' | 'fade' | 'slide' | 'wipe';

const images = new Map<string, HTMLImageElement>();
/** Data-URL images (logo, backgrounds) decoded once and reused every frame. */
function image(src: string | null): HTMLImageElement | null {
  if (!src) return null;
  let img = images.get(src);
  if (!img) {
    img = new Image(); img.src = src; images.set(src, img);
    if (images.size > 24) images.delete(images.keys().next().value!);
  }
  return img.complete && img.naturalWidth ? img : null;
}

type Drawable = HTMLVideoElement | HTMLImageElement;
const size = (el: Drawable) => (el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight]);
const ready = (el: Drawable | null): el is Drawable => !!el && size(el)[0] > 0;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

/** Puts a source in a box: "cover" fills it (cameras), "contain" shows all of it (screens, documents). */
function place(ctx: CanvasRenderingContext2D, el: Drawable | null, x: number, y: number, w: number, h: number, mode: 'cover' | 'contain', label: string, radius = 0) {
  ctx.save();
  if (radius) { roundRect(ctx, x, y, w, h, radius); ctx.clip(); }
  if (!ready(el)) {
    ctx.fillStyle = '#0d2a2e'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(233,244,246,0.55)'; ctx.font = `600 ${Math.max(14, Math.round(h / 14))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + w / 2, y + h / 2, w - 24);
    ctx.restore(); return;
  }
  const [sw, sh] = size(el);
  const k = mode === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
  const dw = sw * k, dh = sh * k;
  if (mode === 'contain') { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); }
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

const LABEL: Record<SourceId, string> = { camera: 'Camera not connected', screen: 'Share a screen in Sources', media: 'Add an image or video in Sources', guests: 'No guest on air' };
const modeOf = (id: SourceId) => (id === 'screen' || id === 'media' ? 'contain' : 'cover');

/** One source in a box; "guests" tiles every on-air guest inside it. */
function source(ctx: CanvasRenderingContext2D, id: SourceId, inputs: Inputs, x: number, y: number, w: number, h: number, radius = 0) {
  if (id === 'guests' && inputs.guests.length > 1) { tiles(ctx, inputs.guests, x, y, w, h, 8); return; }
  const el = id === 'camera' ? inputs.camera : id === 'screen' ? inputs.screen : id === 'media' ? inputs.media : inputs.guests[0] ?? null;
  place(ctx, el, x, y, w, h, modeOf(id), LABEL[id], radius);
}

function tiles(ctx: CanvasRenderingContext2D, feeds: Drawable[], x: number, y: number, w: number, h: number, gap: number) {
  const n = Math.max(1, feeds.length);
  const cols = Math.ceil(Math.sqrt(n)); const rows = Math.ceil(n / cols);
  const tw = (w - gap * (cols - 1)) / cols, th = (h - gap * (rows - 1)) / rows;
  feeds.forEach((f, i) => place(ctx, f, x + (i % cols) * (tw + gap), y + Math.floor(i / cols) * (th + gap), tw, th, 'cover', 'Connecting…', 10));
}

const corner = (c: Corner, w: number, h: number, m: number, bottom = H) => ({ x: c.endsWith('l') ? m : c.endsWith('c') ? (W - w) / 2 : W - w - m, y: c.startsWith('t') ? m : bottom - h - m });
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function drawFrame(ctx: CanvasRenderingContext2D, scene: SceneDef, g: Graphics, inputs: Inputs, timing: Timing, now = performance.now()) {
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
  // Background.
  ctx.fillStyle = scene.background.color || '#071918'; ctx.fillRect(0, 0, W, H);
  const bg = image(scene.background.image);
  if (bg) place(ctx, bg, 0, 0, W, H, 'cover', '');

  // Layout.
  switch (scene.layout) {
    case 'solo': source(ctx, scene.main, inputs, 0, 0, W, H); break;
    case 'pip': {
      source(ctx, scene.main, inputs, 0, 0, W, H);
      const pw = Math.round(W * Math.min(0.4, Math.max(0.18, scene.pipSize))), ph = Math.round(pw * 9 / 16);
      const p = corner(scene.pipCorner, pw, ph, 28);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.fillStyle = g.brand.primary; roundRect(ctx, p.x - 3, p.y - 3, pw + 6, ph + 6, 14); ctx.fill(); ctx.restore();
      source(ctx, scene.second, inputs, p.x, p.y, pw, ph, 12);
      break;
    }
    case 'side': {
      const gap = 16, m = 32, bw = (W - m * 2 - gap) / 2, bh = H - 140;
      source(ctx, scene.main, inputs, m, 54, bw, bh, 14);
      source(ctx, scene.second, inputs, m + bw + gap, 54, bw, bh, 14);
      break;
    }
    case 'grid': {
      const feeds: Drawable[] = [...(inputs.camera ? [inputs.camera] : []), ...inputs.guests];
      if (feeds.length) tiles(ctx, feeds, 32, 40, W - 64, H - 130, 12); else source(ctx, 'camera', inputs, 0, 0, W, H);
      break;
    }
    case 'card': {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = g.brand.accent; ctx.fillRect(W / 2 - 60, 250, 120, 6);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
      ctx.font = '800 64px system-ui, sans-serif'; ctx.fillText(scene.card.title || 'Free Me Live', W / 2, 340, W - 160);
      if (scene.card.subtitle) { ctx.font = '500 30px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText(scene.card.subtitle, W / 2, 392, W - 200); }
      if (scene.card.countdownMin > 0) {
        const left = Math.max(0, Math.ceil(scene.card.countdownMin * 60 - (now - timing.sceneSince) / 1000));
        ctx.font = '800 92px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillStyle = g.brand.accent;
        ctx.fillText(`${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`, W / 2, 500);
      }
      ctx.textAlign = 'left';
      break;
    }
  }

  // How far in (0–1) each graphic is: 1 = fully on screen; animating while between.
  const typing = g.lower.anim === 'type' ? Math.max(700, (g.lower.name.length + g.lower.title.length) * 28) : 0;
  const prog = (part: Part, dur: number, hideAfter = Infinity) => {
    const v = timing[part], t = now - v.at;
    if (!v.on) return 1 - Math.min(1, Math.max(0, t / 400));
    if (t >= hideAfter) return 1 - Math.min(1, (t - hideAfter) / 400);
    return Math.min(1, Math.max(0, t / dur));
  };
  const pTicker = prog('ticker', 500), pLower = prog('lower', typing || 480, g.lower.autoHideSec > 0 ? g.lower.autoHideSec * 1000 : Infinity);
  const pLogo = prog('logo', 600), pClock = prog('clock', 400);
  const tickerOn = pTicker > 0, lowerOn = pLower > 0;

  // Logo (bug). At the bottom it sits above the ticker, and above the lower third when they would meet.
  const logo = pLogo > 0 ? image(g.logo.src) : null;
  if (logo) {
    const maxW = W * g.logo.size, maxH = maxW * 0.6;
    const k = Math.min(maxW / logo.naturalWidth, maxH / logo.naturalHeight);
    const lw = logo.naturalWidth * k, lh = logo.naturalHeight * k;
    let bottom = tickerOn ? H - 56 : H;
    if (lowerOn && (g.logo.corner === 'bl' || g.logo.corner === 'bc')) bottom = 560 - (tickerOn ? 58 : 0);
    const p = corner(g.logo.corner, lw, lh, g.logo.corner.startsWith('b') ? 16 : 28, bottom);
    const edge = g.logo.corner.endsWith('c') ? (g.logo.corner.startsWith('t') ? 'top' : 'bottom') : g.logo.corner.endsWith('l') ? 'left' : 'right';
    // While on screen a logo can keep moving gently.
    const t = now / 1000;
    const scale = g.logo.loop === 'pulse' ? 1 + 0.045 * Math.sin(t * 2.4) : 1;
    const dy = g.logo.loop === 'float' ? 5 * Math.sin(t * 1.6) : 0;
    const bx = p.x + lw / 2, by = p.y + lh / 2 + dy;
    animate(ctx, g.logo.anim, pLogo, { x: p.x, y: p.y + dy, w: lw, h: lh }, edge, () => {
      ctx.globalAlpha *= g.logo.opacity;
      ctx.translate(bx, by); ctx.scale(scale, scale); ctx.translate(-bx, -by);
      if (g.logo.loop === 'shine') ctx.drawImage(shine(logo, lw, lh, now), p.x, p.y + dy, lw, lh);
      else ctx.drawImage(logo, p.x, p.y + dy, lw, lh);
    });
  }
  // Clock, in the top corner the logo does not use.
  if (pClock > 0) {
    const d = new Date(); const text = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    ctx.font = '700 24px system-ui, sans-serif';
    const cw = ctx.measureText(text).width + 28;
    const left = logo ? g.logo.corner !== 'tl' : false;
    const x = left ? 28 : W - cw - 28;
    animate(ctx, g.clock.anim ?? 'fade', pClock, { x, y: 28, w: cw, h: 40 }, 'top', () => {
      ctx.fillStyle = 'rgba(3,16,20,0.75)'; roundRect(ctx, x, 28, cw, 40, 8); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, x + 14, 56);
    });
  }

  // Lower third, with its entrance (and exit when hidden, or after its auto-hide time).
  if (lowerOn) {
    const dy = -58 * ease(pTicker); // rises with the ticker as it comes in
    const box = { x: 32, y: 572 + dy, w: lowerWidth(ctx, g), h: g.lower.title ? 110 : 72 };
    const typed = g.lower.anim === 'type' && timing.lower.on ? pLower : 1;
    // Typewriter: the box fades in quickly, then the letters appear; it fades out when hidden.
    const typewriter = g.lower.anim === 'type';
    animate(ctx, typewriter ? 'fade' : g.lower.anim, typewriter && timing.lower.on ? Math.min(1, pLower * 4) : pLower, box, 'left', () => lowerThird(ctx, g, dy, typed));
  }
  if (tickerOn) animate(ctx, g.ticker.anim === 'type' ? 'slide' : g.ticker.anim, pTicker, { x: 0, y: H - 56, w: W, h: 56 }, 'bottom', () => ticker(ctx, g, now));
  ctx.restore();
}

const easeBack = (t: number) => { const c = 1.7; const x = Math.min(1, Math.max(0, t)) - 1; return 1 + (c + 1) * x ** 3 + c * x ** 2; };
/** Draws a graphic part-way through its entrance or exit (`p` 0 → 1 = coming fully in). */
function animate(ctx: CanvasRenderingContext2D, kind: Anim, p: number, box: { x: number; y: number; w: number; h: number }, edge: 'left' | 'right' | 'top' | 'bottom', draw: () => void) {
  if (p <= 0) return;
  ctx.save();
  if (p < 1 && kind !== 'none') {
    const q = ease(p);
    if (kind === 'fade') ctx.globalAlpha *= q;
    else if (kind === 'slide') {
      const far = edge === 'left' ? box.x + box.w + 20 : edge === 'right' ? W - box.x + 20 : edge === 'top' ? box.y + box.h + 20 : H - box.y + 20;
      const d = (1 - q) * far;
      ctx.translate(edge === 'left' ? -d : edge === 'right' ? d : 0, edge === 'top' ? -d : edge === 'bottom' ? d : 0);
      ctx.globalAlpha *= Math.min(1, q * 1.6);
    } else if (kind === 'pop') {
      const s = 0.55 + 0.45 * easeBack(p);
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
      ctx.globalAlpha *= Math.min(1, p * 2.2);
    } else if (kind === 'wipe') {
      ctx.beginPath(); ctx.rect(box.x - 4, box.y - 8, (box.w + 8) * q, box.h + 16); ctx.clip();
    }
  }
  draw();
  ctx.restore();
}

/** The logo with a diagonal light sweeping across it every few seconds (only over the logo's own pixels). */
const shineCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
function shine(logo: HTMLImageElement, w: number, h: number, now: number) {
  const c = shineCanvas!;
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, c.width, c.height); x.drawImage(logo, 0, 0, c.width, c.height);
  const t = (now % 3500) / 1200; // the sweep takes ~1.2 s, then a pause
  if (t < 1) {
    const sx = -c.width + t * c.width * 3;
    const grad = x.createLinearGradient(sx, 0, sx + c.width * 0.6, c.height);
    grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.75)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    x.globalCompositeOperation = 'source-atop'; x.fillStyle = grad; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'source-over';
  }
  return c;
}

function lowerWidth(ctx: CanvasRenderingContext2D, g: Graphics) {
  ctx.save();
  ctx.font = '800 34px system-ui, sans-serif'; const nameW = ctx.measureText(g.lower.name).width;
  ctx.font = '600 22px system-ui, sans-serif'; const titleW = g.lower.title ? ctx.measureText(g.lower.title).width : 0;
  ctx.restore();
  return Math.min(1040, Math.max(460, nameW + 72, titleW + 72));
}

/** The lower third; `typed` (0–1) shows that share of its letters (the typewriter entrance). */
function lowerThird(ctx: CanvasRenderingContext2D, g: Graphics, dy: number, typed = 1) {
  const full = g.lower.name.length + g.lower.title.length;
  const letters = Math.ceil(full * Math.min(1, typed));
  const name = g.lower.name.slice(0, letters), title = g.lower.title.slice(0, Math.max(0, letters - g.lower.name.length));
  const style = g.lower.style;
  ctx.save(); ctx.translate(0, dy);
  ctx.font = '600 22px system-ui, sans-serif';
  const titleW = g.lower.title ? ctx.measureText(g.lower.title).width : 0;
  const w = lowerWidth(ctx, g);
  const x = 32, y = 572;
  if (style === 'minimal') {
    ctx.fillStyle = 'rgba(0,0,0,0.62)'; roundRect(ctx, x, y, w, g.lower.title ? 108 : 72, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 34px system-ui, sans-serif'; ctx.fillText(name, x + 26, y + 48, w - 52);
    if (g.lower.title) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '600 22px system-ui, sans-serif'; ctx.fillText(title, x + 26, y + 88, w - 52); }
  } else {
    const news = style === 'news';
    ctx.fillStyle = news ? '#ffffff' : g.brand.primary; ctx.fillRect(x, y, w, 72);
    ctx.fillStyle = g.brand.accent; ctx.fillRect(x + w - 10, y, 10, 72);
    ctx.fillStyle = news ? '#0b1a1c' : '#ffffff'; ctx.font = '800 34px system-ui, sans-serif'; ctx.fillText(name, x + 24, y + 48, w - 60);
    if (g.lower.title) {
      ctx.fillStyle = news ? g.brand.primary : '#0b1a1c'; ctx.fillRect(x, y + 72, Math.min(w, titleW + 48), 38);
      ctx.fillStyle = news ? '#ffffff' : g.brand.accent; ctx.font = '600 22px system-ui, sans-serif'; ctx.fillText(title, x + 24, y + 99, w - 48);
    }
  }
  ctx.restore();
}

function ticker(ctx: CanvasRenderingContext2D, g: Graphics, now: number) {
  const y = H - 56, h = 56;
  ctx.fillStyle = '#071312'; ctx.fillRect(0, y, W, h);
  ctx.font = '600 26px system-ui, sans-serif';
  const label = g.ticker.label.trim();
  ctx.font = '800 22px system-ui, sans-serif';
  const lw = label ? ctx.measureText(label).width + 40 : 0;
  ctx.save();
  ctx.beginPath(); ctx.rect(lw, y, W - lw, h); ctx.clip();
  ctx.font = '600 26px system-ui, sans-serif'; ctx.fillStyle = '#fff';
  const text = `${g.ticker.text.trim()}     •     `;
  const tw = ctx.measureText(text).width;
  const offset = ((now / 1000) * 110 * g.ticker.speed) % tw;
  for (let x = lw - offset; x < W; x += tw) ctx.fillText(text, x, y + 37);
  ctx.restore();
  if (label) {
    ctx.fillStyle = g.brand.accent; ctx.fillRect(0, y, lw, h);
    ctx.fillStyle = '#1d1203'; ctx.font = '800 22px system-ui, sans-serif'; ctx.fillText(label, 20, y + 36);
  }
}

/** Draws the outgoing frame over the new one, `p` going 0 → 1 during the transition. */
export function drawTransition(ctx: CanvasRenderingContext2D, old: HTMLCanvasElement, kind: Transition, p: number) {
  const q = ease(p);
  ctx.save();
  if (kind === 'fade') { ctx.globalAlpha = 1 - p; ctx.drawImage(old, 0, 0); }
  else if (kind === 'slide') ctx.drawImage(old, -q * W, 0);
  else if (kind === 'wipe') { ctx.beginPath(); ctx.rect(q * W, 0, W - q * W, H); ctx.clip(); ctx.drawImage(old, 0, 0); }
  ctx.restore();
  if (kind === 'wipe' && q > 0 && q < 1) { ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(q * W - 3, 0, 6, H); }
}
