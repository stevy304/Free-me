'use client';

import { useState } from 'react';
import * as Icon from '@/components/icons';
import { VideoCard } from '@/components/video/VideoCard';
import { useShell } from '@/components/shell/ShellContext';
import { topicName, type T } from '@/i18n';
import type { VideoCardData } from '@/lib/types';

/** Why a video is in "For you" (see ALGORITHM.md): shown under each card, so the feed explains itself. */
export type ForYouReason =
  | { kind: 'related'; title: string | null }
  | { kind: 'topic'; topic: { slug: string; name: string } | null }
  | { kind: 'following' | 'trending' | 'new' | 'popular' };
export type ForYouVideo = VideoCardData & { reason: ForYouReason };
export interface ForYouPage { videos: ForYouVideo[]; page: number; nextPage: number | null }

export function reasonText(t: T, r: ForYouReason): string {
  if (r.kind === 'related') return r.title ? t('foryou.related', { title: r.title }) : t('foryou.popular');
  if (r.kind === 'topic') return r.topic ? t('foryou.topic', { topic: topicName(t, r.topic.slug, r.topic.name) }) : t('foryou.popular');
  return t(`foryou.${r.kind}`);
}

const ICON = { related: Icon.Trail, topic: Icon.Compass, following: Icon.Following, trending: Icon.Spark, new: Icon.Clock, popular: Icon.Eye } as const;

/** The ranked "For you" grid: 8 at first, then a page of 24 at a time. */
export function ForYou({ initial, signedIn }: { initial: ForYouPage; signedIn: boolean }) {
  const { locale, t } = useShell();
  const [videos, setVideos] = useState(initial.videos);
  const [next, setNext] = useState(initial.nextPage);
  const [shown, setShown] = useState(8);
  const [busy, setBusy] = useState(false);
  const more = async () => {
    if (shown < videos.length) { setShown(videos.length); return; }
    if (next === null) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/feed/for-you?page=${next}`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = (await r.json()) as ForYouPage;
      setVideos((v) => [...v, ...d.videos.filter((x) => !v.some((y) => y.id === x.id))]);
      setNext(d.nextPage);
      setShown(Infinity);
    } finally { setBusy(false); }
  };
  if (!videos.length) return null;
  const list = videos.slice(0, shown);
  const canMore = shown < videos.length || next !== null;
  return (
    <section aria-labelledby="foryou-heading" className="mt-9">
      <div className="sm:flex sm:items-baseline sm:gap-2.5">
        <h2 id="foryou-heading" className="text-[22px] font-bold leading-tight">{t('foryou.title')}</h2>
        <p className="text-[13px] font-medium text-muted">{t(signedIn ? 'foryou.note' : 'foryou.noteVisitor')}</p>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
        {list.map((v) => {
          const I = ICON[v.reason.kind];
          return (
            <div key={v.id}>
              <VideoCard v={v} locale={locale} />
              <p className="mt-1.5 flex items-center gap-1 text-[12px] font-medium text-muted"><I size={13} className="shrink-0" /><span className="truncate">{reasonText(t, v.reason)}</span></p>
            </div>
          );
        })}
      </div>
      {canMore && (
        <div className="mt-6 flex justify-center">
          <button type="button" onClick={() => void more()} disabled={busy} className="flex h-10 items-center gap-2 rounded-xl border border-line px-5 text-[14px] font-semibold hover:bg-surface disabled:opacity-50">
            {busy && <Icon.Spinner size={16} className="animate-spin" />}{t('foryou.more')}
          </button>
        </div>
      )}
    </section>
  );
}
