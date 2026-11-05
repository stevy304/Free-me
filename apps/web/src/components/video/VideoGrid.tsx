'use client';

import * as Icon from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { VideoCard } from './VideoCard';
import { useShell } from '../shell/ShellContext';
import type { VideoCardData, VideoPage } from '@/lib/types';

/** Responsive grid that loads the next page when its end scrolls into view. */
export function VideoGrid({ first, endpoint }: { first: VideoPage; endpoint: string }) {
  const { locale } = useShell();
  const [videos, setVideos] = useState<VideoCardData[]>(first.videos);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { setVideos(first.videos); setCursor(first.nextCursor); }, [first]);
  useEffect(() => {
    if (!cursor || !end.current) return;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting || loading) return;
      setLoading(true); setError(false);
      try {
        const sep = endpoint.includes('?') ? '&' : '?';
        const r = await fetch(`/api${endpoint}${sep}cursor=${encodeURIComponent(cursor)}`);
        if (!r.ok) throw new Error();
        const d: VideoPage = await r.json();
        setVideos((v) => [...v, ...d.videos.filter((x) => !v.some((y) => y.id === x.id))]);
        setCursor(d.nextCursor);
      } catch { setError(true); } finally { setLoading(false); }
    }, { rootMargin: '600px' });
    io.observe(end.current);
    return () => io.disconnect();
  }, [cursor, endpoint, loading]);

  return (
    <>
      <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5">
        {videos.map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
      </div>
      <div ref={end} className="flex justify-center py-8">
        {loading && <Icon.Spinner className="animate-spin text-muted" />}
        {error && <p className="text-[14px] text-muted">Could not load more videos. Scroll to try again.</p>}
      </div>
    </>
  );
}
