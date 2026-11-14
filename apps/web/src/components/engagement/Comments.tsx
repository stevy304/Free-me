'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { COMMENT_MAX } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { me } from '@/lib/me';
import { buttonClass } from '@/components/Dialog';
import { useShell, useT } from '@/components/shell/ShellContext';
import { api } from '@/lib/client-api';
import { compactNumber, timeAgo } from '@/lib/format';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { useRealtime } from '@/lib/realtime';

export interface CommentData {
  id: string; parentId: string | null; content: string; deleted: boolean; isPinned: boolean; replyCount: number; createdAt: string; editedAt: string | null;
  author: { name: string; handle: string | null; avatarUrl: string | null; isCreator: boolean; isVerified: boolean; badge?: 'verified' | 'premium' | null } | null;
  can: { edit: boolean; delete: boolean; pin: boolean };
}
interface Page { open: boolean; closedReason?: string; count: number; comments: CommentData[]; nextCursor: string | null }

/** Text box that grows with its content; Ctrl/Cmd+Enter sends. */
function Composer({ placeholder, initial = '', submitLabel, autoFocus, onSubmit, onCancel }: { placeholder: string; initial?: string; submitLabel: string; autoFocus?: boolean; onSubmit: (text: string) => Promise<void>; onCancel?: () => void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const [focused, setFocused] = useState(!!autoFocus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; } }, [text]);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    try { await onSubmit(text); setText(''); setFocused(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="min-w-0 flex-1">
      <textarea
        ref={ref} value={text} rows={1} maxLength={COMMENT_MAX} placeholder={placeholder} autoFocus={autoFocus} aria-label={placeholder}
        onFocus={() => setFocused(true)} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
        className="block w-full resize-none overflow-hidden border-b border-line bg-transparent pb-1 text-[14px] outline-none placeholder:text-muted focus:border-ink"
      />
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      {(focused || onCancel) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {text.length > COMMENT_MAX - 200 && <span className="mr-auto text-[12px] text-muted">{t('comments.charsLeft', { count: COMMENT_MAX - text.length })}</span>}
          <button type="button" className={buttonClass.quiet} onClick={() => { setText(initial); setFocused(false); onCancel?.(); }}>{t('comments.cancel')}</button>
          <button type="button" className={buttonClass.primary} disabled={!text.trim() || busy || text === initial} onClick={send}>{busy && <Icon.Spinner size={14} className="animate-spin" />}{submitLabel}</button>
        </div>
      )}
    </div>
  );
}

function CommentItem({ c, videoId, onChange, onRemoved, onReplied, isReply = false }: {
  c: CommentData; videoId: string; onChange: (c: CommentData) => void; onRemoved: (c: CommentData) => void; onReplied: () => void; isReply?: boolean;
}) {
  const { viewer, locale, t } = useShell();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replies, setReplies] = useState<CommentData[] | null>(null);
  const [showReplies, setShowReplies] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReplies = useCallback(async () => { const r = await api<{ replies: CommentData[] }>(`/comments/${c.id}/replies`); setReplies(r.replies); }, [c.id]);
  const toggleReplies = async () => { if (!showReplies && !replies) await loadReplies().catch((e) => setError((e as Error).message)); setShowReplies((s) => !s); };
  const remove = async () => {
    setMenu(false);
    if (!window.confirm(t('comments.removeConfirm'))) return;
    try { await api(`/comments/${c.id}`, { method: 'DELETE', body: {} }); onRemoved(c); } catch (e) { setError((e as Error).message); }
  };
  const pin = async () => {
    setMenu(false);
    try { await api(`/comments/${c.id}/pin`, { method: c.isPinned ? 'DELETE' : 'POST', body: {} }); router.refresh(); onChange({ ...c, isPinned: !c.isPinned }); } catch (e) { setError((e as Error).message); }
  };

  if (c.deleted) {
    return (
      <div className="flex gap-3 py-2">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-faint"><Icon.Comment size={18} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] italic text-muted">{t('comments.removed')}</p>
          {c.replyCount > 0 && <RepliesToggle n={c.replyCount} open={showReplies} onClick={toggleReplies} />}
          {showReplies && replies?.map((r) => <CommentItem key={r.id} c={r} videoId={videoId} isReply onChange={(x) => setReplies((l) => l!.map((y) => y.id === x.id ? x : y))} onRemoved={(x) => { setReplies((l) => l!.filter((y) => y.id !== x.id)); onRemoved(x); }} onReplied={onReplied} />)}
        </div>
      </div>
    );
  }

  const author = c.author!;
  const who = author.handle ? <Link href={`/@${author.handle}`} className="font-semibold hover:underline">@{author.handle}</Link> : <span className="font-semibold">{author.name}</span>;
  return (
    <div className="group flex gap-3 py-2">
      {author.handle ? <Link href={`/@${author.handle}`} className="shrink-0"><Avatar name={author.name} src={author.avatarUrl} size={isReply ? 28 : 40} /></Link> : <Avatar name={author.name} src={author.avatarUrl} size={isReply ? 28 : 40} />}
      <div className="min-w-0 flex-1">
        {c.isPinned && <p className="mb-0.5 flex items-center gap-1 text-[12px] text-muted"><Icon.Pin size={13} filled />{t('comments.pinned')}</p>}
        <p className="flex flex-wrap items-center gap-x-1.5 text-[13px]">
          <span className={author.isCreator ? 'rounded-full bg-surface px-2 py-0.5' : ''}>{who}</span>
          {author.isVerified && <VerifiedBadge size={14} kind={author.badge} />}
          <span className="text-muted" suppressHydrationWarning>{timeAgo(c.createdAt, locale)}{c.editedAt ? ' (edited)' : ''}</span>
        </p>
        {editing
          ? <div className="mt-1 flex"><Composer placeholder={t('comments.editPlaceholder')} initial={c.content} submitLabel={t('comments.save')} autoFocus onCancel={() => setEditing(false)} onSubmit={async (text) => { const r = await api<{ comment: CommentData }>(`/comments/${c.id}`, { method: 'PATCH', body: { content: text } }); onChange(r.comment); setEditing(false); }} /></div>
          : <p className="mt-0.5 whitespace-pre-line break-words text-[14px] leading-5">{c.content}</p>}
        {!editing && (
          <div className="mt-1 flex items-center gap-1">
            {viewer
              ? <button type="button" onClick={() => setReplying(true)} className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-[12px] font-semibold hover:bg-surface"><Icon.Reply size={16} />{t('comments.replyBtn')}</button>
              : <Link href={`/login?returnTo=${encodeURIComponent(`/watch?v=${videoId}`)}`} className="flex h-8 items-center rounded-xl px-3 text-[12px] font-semibold hover:bg-surface">{t('comments.replyBtn')}</Link>}
          </div>
        )}
        {replying && (
          <div className="mt-2 flex gap-3">
            {viewer ? <Avatar {...me(viewer)} size={24} /> : <Avatar name="" size={24} />}
            <Composer placeholder={t('comments.replyPlaceholder')} initial={isReply && author.handle ? `@${author.handle} ` : ''} submitLabel={t('comments.replyBtn')} autoFocus onCancel={() => setReplying(false)}
              onSubmit={async (text) => {
                const r = await api<{ comment: CommentData }>(`/videos/${videoId}/comments`, { body: { content: text, parentId: c.id } });
                setReplying(false);
                // A reply to a reply joins the same thread: the thread above reloads it.
                if (isReply) { onReplied(); return; }
                onReplied();
                onChange({ ...c, replyCount: c.replyCount + 1 });
                setReplies((l) => [...(l ?? []), r.comment]); setShowReplies(true);
              }} />
          </div>
        )}
        {!isReply && c.replyCount > 0 && <RepliesToggle n={c.replyCount} open={showReplies} onClick={toggleReplies} />}
        {showReplies && replies && (
          <div className="mt-1">
            {replies.map((r) => <CommentItem key={r.id} c={r} videoId={videoId} isReply
              onChange={(x) => setReplies((l) => l!.map((y) => y.id === x.id ? x : y))}
              onRemoved={(x) => { setReplies((l) => l!.filter((y) => y.id !== x.id)); onChange({ ...c, replyCount: c.replyCount - 1 }); onRemoved(x); }}
              onReplied={() => { onReplied(); onChange({ ...c, replyCount: c.replyCount + 1 }); void loadReplies(); }} />)}
          </div>
        )}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
      {(c.can.edit || c.can.delete || c.can.pin) && (
        <div className="relative shrink-0">
          <button type="button" aria-label={t('comments.actions')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="grid h-9 w-9 place-items-center rounded-full opacity-100 hover:bg-surface sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><Icon.More size={20} /></button>
          {menu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
              <div role="menu" className="absolute right-0 top-10 z-40 min-w-[160px] rounded-xl bg-elevated py-2 shadow-[var(--shadow)]">
                {c.can.pin && <button type="button" role="menuitem" onClick={pin} className="flex w-full items-center gap-3 px-4 py-2 text-[14px] hover:bg-surface"><Icon.Pin size={18} />{c.isPinned ? t('comments.unpin') : t('comments.pin')}</button>}
                {c.can.edit && <button type="button" role="menuitem" onClick={() => { setMenu(false); setEditing(true); }} className="flex w-full items-center gap-3 px-4 py-2 text-[14px] hover:bg-surface"><Icon.Pencil size={18} />{t('comments.edit')}</button>}
                {c.can.delete && <button type="button" role="menuitem" onClick={remove} className="flex w-full items-center gap-3 px-4 py-2 text-[14px] hover:bg-surface"><Icon.Trash size={18} />{t('comments.remove')}</button>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RepliesToggle({ n, open, onClick }: { n: number; open: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onClick} className="mt-1 flex h-9 items-center gap-2 rounded-xl px-3 text-[14px] font-semibold text-brand hover:bg-brand-soft">
      {open ? <Icon.ChevronUp size={18} /> : <Icon.ChevronDown size={18} />}{t(n === 1 ? 'comments.reply.one' : 'comments.reply.other', { count: n })}
    </button>
  );
}

/** Comments under a video: count, sort, write, then the list (pinned first) with "load more". */
/**
 * The conversation under a video. `card`: the watch page's Comments card beside the video (same look as Up next,
 * always dark like the stage): its list scrolls inside the card.
 */
export function Comments({ videoId, initialCount, variant }: { videoId: string; initialCount: number; variant?: 'card' }) {
  const { viewer, locale, t } = useShell();
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState<Page | null>(null);
  const [count, setCount] = useState(initialCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(null); setError(null);
    api<Page>(`/videos/${videoId}/comments?sort=${sort}`).then((p) => { setPage(p); setCount(p.count); }).catch((e) => setError((e as Error).message));
  }, [videoId, sort]);
  // Someone else commented: the first page (and the count) refresh in place, keeping what is already loaded below it.
  useRealtime<{ parentId?: string | null }>('comments', () => {
    api<Page>(`/videos/${videoId}/comments?sort=${sort}`).then((p) => {
      setCount(p.count);
      setPage((cur) => {
        if (!cur) return p;
        const fresh = new Set(p.comments.map((c) => c.id));
        return { ...p, comments: [...p.comments, ...cur.comments.filter((c) => !fresh.has(c.id))], nextCursor: cur.nextCursor };
      });
    }).catch(() => undefined);
  }, `video:${videoId}`);

  const more = async () => {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try { const p = await api<Page>(`/videos/${videoId}/comments?sort=${sort}&cursor=${encodeURIComponent(page.nextCursor)}`); setPage({ ...p, comments: [...page.comments, ...p.comments] }); } catch (e) { setError((e as Error).message); } finally { setLoadingMore(false); }
  };
  const update = (c: CommentData) => setPage((p) => p && ({ ...p, comments: c.isPinned ? [c, ...p.comments.filter((x) => x.id !== c.id).map((x) => ({ ...x, isPinned: false }))] : p.comments.map((x) => x.id === c.id ? c : x) }));
  const removed = (c: CommentData) => { setCount((n) => Math.max(0, n - 1)); if (!c.parentId) setPage((p) => p && ({ ...p, comments: c.replyCount > 0 ? p.comments.map((x) => x.id === c.id ? { ...x, deleted: true, content: '', author: null } : x) : p.comments.filter((x) => x.id !== c.id) })); };

  if (page && !page.open) {
    return <section aria-label={t('comments.conversation')} className="mt-5 rounded-2xl bg-surface px-4 py-3 text-[14px] text-muted"><Icon.Comment size={18} className="mr-2 inline" />{page.closedReason}</section>;
  }

  const card = variant === 'card';
  const sortPicker = (
    <label className={`flex items-center gap-2 text-[14px] font-medium ${card ? 'facet-sm bg-white/[0.08] px-2.5 py-1 text-[13px] text-white' : ''}`}>
      <Icon.Sort size={card ? 16 : 20} /><span className="sr-only">{t('comments.sortBy')}</span>
      <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded-md bg-transparent py-1 outline-none hover:bg-surface">
        <option value="newest">{t('comments.newest')}</option><option value="oldest">{t('comments.oldest')}</option>
      </select>
    </label>
  );
  return (
    <section aria-label={t('comments.conversation')} className={card ? 'dark flex h-full min-h-0 flex-col text-ink' : 'mt-5'}>
      {card ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-baseline gap-2 text-[20px] font-extrabold text-white">
              {t('watch.comments')}
              <span className="font-sans text-[14px] font-semibold text-[#b0a397]" suppressHydrationWarning>{compactNumber(count, locale)}</span>
            </h2>
            {sortPicker}
          </div>
          <div className="zigzag mb-3 mt-2.5" aria-hidden />
        </>
      ) : (
      <div className="flex items-center gap-6">
        <h2 className="text-[18px] font-bold" suppressHydrationWarning>{t('watch.conversation')} <span className="font-sans text-[14px] font-medium text-muted">{compactNumber(count, locale)}</span></h2>
        {sortPicker}
      </div>
      )}
      <div className={card ? 'flex gap-2.5' : 'mt-5 flex gap-3'}>
        {viewer
          ? <><Avatar {...me(viewer)} size={card ? 34 : 40} />
            <Composer placeholder={t('comments.joinPlaceholder')} submitLabel={t('comments.post')} onSubmit={async (text) => {
              const r = await api<{ comment: CommentData }>(`/videos/${videoId}/comments`, { body: { content: text } });
              setCount((n) => n + 1);
              setPage((p) => p && ({ ...p, comments: p.comments[0]?.isPinned ? [p.comments[0], r.comment, ...p.comments.slice(1)] : [r.comment, ...p.comments] }));
            }} /></>
          : <Link href={`/login?returnTo=${encodeURIComponent(`/watch?v=${videoId}`)}`} className="flex w-full items-center gap-3 border-b border-line pb-2 text-[14px] text-muted hover:text-ink"><Icon.PersonCircle size={40} strokeWidth={1.3} />{t('comments.signIn')}</Link>}
      </div>
      <div className={card ? 'no-scrollbar -mx-2 mt-3 min-h-0 flex-1 overflow-y-auto px-2' : 'mt-4'}>
        {!page && !error && <div className="grid place-items-center py-6"><Icon.Spinner className="animate-spin text-muted" /></div>}
        {page?.comments.map((c) => <CommentItem key={c.id} c={c} videoId={videoId} onChange={update} onRemoved={removed} onReplied={() => setCount((n) => n + 1)} />)}
        {page && page.comments.length === 0 && <p className="py-6 text-center text-[14px] text-muted">{t('comments.none')}</p>}
        {page?.nextCursor && <button type="button" className={`${buttonClass.soft} mt-2`} onClick={more} disabled={loadingMore}>{loadingMore && <Icon.Spinner size={14} className="animate-spin" />}Show more</button>}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      </div>
    </section>
  );
}
