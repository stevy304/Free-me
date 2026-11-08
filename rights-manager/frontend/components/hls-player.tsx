"use client";

import Hls, { type Level } from "hls.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface QualityLevel { index: number; height: number; bitrate: number; name: string }
export interface PlayerHandle {
  video: HTMLVideoElement | null;
  levels: QualityLevel[];
  /** -1 = Auto (adaptive). Switching never reloads the page or restarts playback. */
  setLevel: (index: number) => void;
}

interface Props {
  src: string | null;
  live?: boolean;
  muted?: boolean;
  autoPlay?: boolean;
  controls?: boolean;
  className?: string;
  /** Called with the levels when the master playlist loads, and with the level playing when it changes. */
  onLevels?: (levels: QualityLevel[]) => void;
  onLevelPlaying?: (index: number, auto: boolean) => void;
  onError?: (message: string | null) => void;
  /** Extra headers (e.g. Authorization) for private playlists. */
  token?: string | null;
}

/** hls.js with adaptive bitrate; Safari plays HLS natively. */
export const HlsPlayer = forwardRef<PlayerHandle, Props>(function HlsPlayer(
  { src, live, muted, autoPlay = true, controls = true, className, onLevels, onLevelPlaying, onError, token },
  ref,
) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<QualityLevel[]>([]);

  useImperativeHandle(ref, () => ({
    video: video.current,
    levels,
    setLevel: (i: number) => {
      if (!hls.current) return;
      // currentLevel flushes the buffer for an immediate switch; -1 hands control back to ABR.
      hls.current.currentLevel = i;
      if (i === -1) hls.current.nextLevel = -1;
    },
  }), [levels]);

  useEffect(() => {
    const el = video.current;
    if (!el || !src) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (Hls.isSupported()) {
      const h = new Hls({
        lowLatencyMode: !!live,
        liveSyncDurationCount: live ? 2 : 3,
        backBufferLength: live ? 10 : 60,
        capLevelToPlayerSize: false,
        xhrSetup: token ? (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${token}`) : undefined,
      });
      hls.current = h;
      h.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        const ls = data.levels.map((l: Level, index: number) => ({ index, height: l.height, bitrate: l.bitrate, name: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps` }));
        setLevels(ls);
        onLevels?.(ls);
        onError?.(null);
        if (autoPlay) el.play().catch(() => undefined);
      });
      h.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => onLevelPlaying?.(data.level, h.autoLevelEnabled));
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { h.recoverMediaError(); return; }
        onError?.(live ? "Waiting for the stream…" : "The video could not be loaded.");
        // Live streams appear a few seconds after the encoder connects: keep trying.
        retry = setTimeout(() => { h.loadSource(src); h.startLoad(); }, 3000);
      });
      h.loadSource(src);
      h.attachMedia(el);
      return () => { clearTimeout(retry); h.destroy(); hls.current = null; };
    }
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = src;
      if (autoPlay) el.play().catch(() => undefined);
    }
    return () => clearTimeout(retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, live, token]);

  return <video ref={video} className={className} muted={muted} playsInline controls={controls} />;
});
