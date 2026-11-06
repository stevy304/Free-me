'use client';

/**
 * Data saver for this device: "auto" (default) turns it on when the phone asks to save data or the connection is
 * slow (2G/3G); "on" always; "off" never. While it is on, videos play at 360p at most unless a higher quality is
 * chosen in the player.
 */
export type DataSaver = 'auto' | 'on' | 'off';
const KEY = 'fm_data_saver';

export function getDataSaver(): DataSaver {
  try { const v = localStorage.getItem(KEY); return v === 'on' || v === 'off' ? v : 'auto'; } catch { return 'auto'; }
}
export function setDataSaver(v: DataSaver) { try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ } }

interface Connection { saveData?: boolean; effectiveType?: string }
export function dataSaverActive(): boolean {
  const v = getDataSaver();
  if (v !== 'auto') return v === 'on';
  const c = (typeof navigator !== 'undefined' ? (navigator as { connection?: Connection }).connection : undefined);
  return !!c && (c.saveData === true || ['slow-2g', '2g', '3g'].includes(c.effectiveType ?? ''));
}

/** The highest quality data saver allows (short side of the picture). */
export const DATA_SAVER_MAX = 360;
