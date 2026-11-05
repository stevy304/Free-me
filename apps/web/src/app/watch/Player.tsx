'use client';

import { useEffect, useRef, useState } from 'react';

/** Adaptive (HLS) playback: native on Safari, hls.js elsewhere. */
export function Player({ src, poster }: { src: string; poster: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (el.canPlayType('application/vnd.apple.mpegurl')) { el.src = src; return; }
    let destroy = () => {};
    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) { setError(true); return; }
      const hls = new Hls({ capLevelToPlayerSize: true });
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) setError(true); });
      hls.loadSource(src); hls.attachMedia(el);
      destroy = () => hls.destroy();
    });
    return () => destroy();
  }, [src]);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
      <video ref={video} controls playsInline poster={poster ?? undefined} className="h-full w-full" />
      {error && <p className="absolute inset-0 grid place-items-center text-[15px] text-white">This video cannot be played right now.</p>}
    </div>
  );
}
