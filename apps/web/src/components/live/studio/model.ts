/**
 * Live Studio show model: scenes (what is on screen and how it is laid out), graphics (logo, lower third, ticker,
 * clock) and the brand kit. Saved on this computer so a show is ready the next time the studio opens.
 */

/** solo: one source full frame · pip: main + small corner · side: two side by side · grid: guests tiled
 *  · card: a full-screen title or countdown (Starting soon, Break, Thanks for watching). */
export type Layout = 'solo' | 'pip' | 'side' | 'grid' | 'card';
/** camera: the host's main input · screen: the shared screen · media: an image or video file · guests: on-air guests. */
export type SourceId = 'camera' | 'screen' | 'media' | 'guests';
/** Where a logo or corner picture sits: top/bottom × left/centre/right. */
export type Corner = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';

export interface SceneDef {
  id: string;
  name: string;
  layout: Layout;
  main: SourceId;
  /** Second source for pip and side layouts. */
  second: SourceId;
  pipCorner: Corner;
  /** Width of the corner picture, as a share of the frame (0.18–0.4). */
  pipSize: number;
  /** Card layout: big title, smaller line, optional countdown in minutes. */
  card: { title: string; subtitle: string; countdownMin: number };
  /** Hex colour behind everything; an image (data URL) when set. */
  background: { color: string; image: string | null };
  /** Whether the host microphone is heard while this scene is on air (off for break cards). */
  hostMic: boolean;
}

export type LowerStyle = 'brand' | 'news' | 'minimal';
/** How a graphic comes in and goes out. "type" (lower third only): the words appear letter by letter. */
export type Anim = 'none' | 'fade' | 'slide' | 'pop' | 'wipe' | 'type';
/** A logo can keep moving gently while it is on screen. */
export type Loop = 'none' | 'pulse' | 'float' | 'shine';
export interface Graphics {
  logo: { show: boolean; src: string | null; corner: Corner; size: number; opacity: number; anim: Anim; loop: Loop };
  lower: { show: boolean; name: string; title: string; style: LowerStyle; autoHideSec: number; anim: Anim };
  ticker: { show: boolean; label: string; text: string; speed: number; anim: Anim };
  clock: { show: boolean; anim?: Anim };
  brand: { primary: string; accent: string };
}

export const BRAND_PRIMARY = '#08645f';
export const defaultGraphics = (): Graphics => ({
  logo: { show: true, src: null, corner: 'tr', size: 0.13, opacity: 1, anim: 'pop', loop: 'none' },
  lower: { show: false, name: '', title: '', style: 'brand', autoHideSec: 0, anim: 'slide' },
  ticker: { show: false, label: 'LIVE', text: '', speed: 1, anim: 'slide' },
  clock: { show: false, anim: 'fade' },
  brand: { primary: BRAND_PRIMARY, accent: '#f5b95c' },
});

const scene = (id: string, name: string, p: Partial<SceneDef>): SceneDef => ({
  id, name, layout: 'solo', main: 'camera', second: 'guests', pipCorner: 'br', pipSize: 0.28,
  card: { title: '', subtitle: '', countdownMin: 0 }, background: { color: '#071918', image: null }, hostMic: true, ...p,
});
export const defaultScenes = (): SceneDef[] => [
  scene('opening', 'Opening', { layout: 'card', card: { title: 'Starting soon', subtitle: 'Stay with us', countdownMin: 5 }, hostMic: false }),
  scene('host', 'Host', { layout: 'solo', main: 'camera' }),
  scene('guests', 'Host + Guest', { layout: 'side', main: 'camera', second: 'guests' }),
  scene('screen', 'Screen + Host', { layout: 'pip', main: 'screen', second: 'camera', pipCorner: 'br' }),
  scene('break', 'Break', { layout: 'card', card: { title: 'We’ll be right back', subtitle: '', countdownMin: 0 }, hostMic: false }),
];

export const ANIMS: Array<{ id: Anim; label: string }> = [
  { id: 'slide', label: 'Slide in' }, { id: 'fade', label: 'Fade' }, { id: 'pop', label: 'Pop (zoom)' }, { id: 'wipe', label: 'Wipe' }, { id: 'type', label: 'Typewriter' }, { id: 'none', label: 'No animation' },
];
export const LOOPS: Array<{ id: Loop; label: string }> = [{ id: 'none', label: 'Still' }, { id: 'pulse', label: 'Pulse' }, { id: 'float', label: 'Float' }, { id: 'shine', label: 'Shine' }];

export const LAYOUTS: Array<{ id: Layout; label: string }> = [
  { id: 'solo', label: 'Solo' }, { id: 'pip', label: 'Picture in picture' }, { id: 'side', label: 'Side by side' }, { id: 'grid', label: 'Grid' }, { id: 'card', label: 'Title card' },
];
export const SOURCES: Array<{ id: SourceId; label: string }> = [
  { id: 'camera', label: 'Camera' }, { id: 'screen', label: 'Screen share' }, { id: 'media', label: 'Image or video' }, { id: 'guests', label: 'Guests' },
];

/** A copy made on "Take to air", so later edits stay in preview until the next take. */
export const cloneScene = (s: SceneDef): SceneDef => ({ ...s, card: { ...s.card }, background: { ...s.background } });
export const cloneGraphics = (g: Graphics): Graphics => ({ logo: { ...g.logo }, lower: { ...g.lower }, ticker: { ...g.ticker }, clock: { ...g.clock }, brand: { ...g.brand } });

const KEY = 'fm_studio_v1';
export interface SavedShow { scenes: SceneDef[]; graphics: Graphics }
export function loadShow(): SavedShow {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SavedShow>;
      const d = defaultGraphics();
      if (Array.isArray(s.scenes) && s.scenes.length) {
        const g = s.graphics ?? d;
        return {
          scenes: s.scenes.map((x) => scene(x.id, x.name, x)),
          graphics: { logo: { ...d.logo, ...g.logo }, lower: { ...d.lower, ...g.lower }, ticker: { ...d.ticker, ...g.ticker }, clock: { ...d.clock, ...g.clock }, brand: { ...d.brand, ...g.brand } },
        };
      }
    }
  } catch { /* storage blocked or old data */ }
  return { scenes: defaultScenes(), graphics: defaultGraphics() };
}
/** Returns false when the browser refused (images too large for this computer's storage). */
export function saveShow(show: SavedShow): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(show)); return true; } catch { return false; }
}

/** Reads an image file into a data URL after shrinking it (logos and backgrounds stay small enough to save). */
export function readImage(file: File, maxSide: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 8_000_000) { reject(new Error('Choose a PNG, JPEG, WebP or GIF image under 8 MB.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}
