'use client';

import { useEffect, useRef, useState } from 'react';
import type { VideoCardData } from '@/lib/types';

const START_AFTER_MS = 400;
const FRAME_MS = 240;

/**
 * Hover preview: when the pointer rests on a card, it flicks through the video's seek-bar sprite sheet (one small
 * image, already made for every video), with a thin progress line. No video is loaded, so it costs one image instead
 * of a stream: affordable on mobile data. Mouse and trackpad only (phones scroll past cards; a preview would spend
 * their data), and never for people who ask for reduced motion.
 */
export function HoverPreview({ preview }: { preview: NonNullable<VideoCardData['preview']> }) {
  const box = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(-1);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    const card = el?.closest('a');
    if (!el || !card) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearTimeout(wait); clearInterval(tick); setFrame(-1); };
    const start = () => {
      stop();
      wait = setTimeout(() => {
        const img = new Image();
        img.onload = () => setReady(true);
        img.src = preview.url;
        setFrame(0);
        tick = setInterval(() => setFrame((f) => (f + 1) % preview.count), FRAME_MS);
      }, START_AFTER_MS);
    };
    card.addEventListener('mouseenter', start);
    card.addEventListener('mouseleave', stop);
    card.addEventListener('focus', start);
    card.addEventListener('blur', stop);
    return () => { stop(); card.removeEventListener('mouseenter', start); card.removeEventListener('mouseleave', stop); card.removeEventListener('focus', start); card.removeEventListener('blur', stop); };
  }, [preview.url, preview.count]);

  const on = frame >= 0 && ready;
  const rows = Math.ceil(preview.count / preview.cols);
  const col = frame % preview.cols;
  const row = Math.floor(Math.max(0, frame) / preview.cols);
  return (
    <div ref={box} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden bg-black transition-opacity duration-200 ${on ? 'opacity-100' : 'opacity-0'}`}>
      {on && (
        <>
          {/* One tile of the sheet, covering the frame (cropped at the sides, like the thumbnail). */}
          <div className="absolute left-1/2 top-0 h-full -translate-x-1/2" style={{
            aspectRatio: `${preview.width} / ${preview.height}`, minWidth: '100%',
            backgroundImage: `url(${preview.url})`, backgroundSize: `${preview.cols * 100}% ${rows * 100}%`,
            backgroundPosition: `${preview.cols > 1 ? (col / (preview.cols - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
          }} />
          <div className="absolute inset-x-0 top-0 h-[3px] bg-white/25"><div className="h-full bg-[var(--accent)] transition-[width] duration-200 ease-linear" style={{ width: `${((frame + 1) / preview.count) * 100}%` }} /></div>
        </>
      )}
    </div>
  );
}
