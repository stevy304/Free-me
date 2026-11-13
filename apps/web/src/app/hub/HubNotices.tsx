'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { signatureMatches } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/client-api';
import { fullDate } from '@/lib/format';

interface Removal {
  video: { id: string; title: string; thumbnailUrl: string | null }; takenDownAt: string; reason: string; reasonLabel: string; moderatorNote: string | null;
  notice: { id: string; claimantName: string; originalWork: string; details: string | null; receivedAt: string } | null;
  counter: { submittedAt: string } | null; canCounter: boolean;
}
interface Data { removals: Removal[]; strikes: { copyright: number; guidelines: number; windowDays: number } }

/** Removed videos, why they were removed, strikes, and the counter-notice form for copyright removals. */
export function HubNotices() {
  const { locale, t } = useShell();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counterFor, setCounterFor] = useState<Removal | null>(null);
  const load = () => api<Data>('/hub/notices').then(setData).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);

  if (error) return <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>;
  if (!data) return <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const s = data.strikes;
  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {([['notices.copyrightStrikes', s.copyright, Icon.Copyright], ['notices.guidelineStrikes', s.guidelines, Icon.Shield]] as const).map(([l, n, I]) => (
          <div key={l} className={`flex items-center gap-4 rounded-2xl border p-4 ${n ? 'border-danger/40 bg-danger/5' : 'border-line'}`}>
            <div className={`grid h-12 w-12 place-items-center rounded-full ${n ? 'bg-danger/15 text-danger' : 'bg-brand-soft text-brand'}`}><I size={24} /></div>
            <div><p className="text-[24px] font-bold leading-7">{n}</p><p className="text-[13px] text-muted">{t(l, { days: s.windowDays })}</p></div>
          </div>
        ))}
      </div>
      <p className="text-[13px] text-muted">{t('notices.strikeRule', { days: s.windowDays })} <Link href="/legal/guidelines" className="text-brand">{t('hub.guidelines')}</Link> · <Link href="/legal/copyright" className="text-brand">{t('notices.copyrightPolicy')}</Link></p>
      {data.removals.length === 0
        ? <div className="rounded-2xl border border-line px-6 py-12 text-center"><Icon.CheckCircle size={40} filled className="mx-auto text-brand" /><p className="mt-3 text-[16px] font-semibold">{t('notices.goodStanding')}</p><p className="text-[14px] text-muted">{t('notices.noneRemoved')}</p></div>
        : data.removals.map((r) => (
          <article key={r.video.id} className="rounded-2xl border border-line p-4">
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-surface sm:w-48">{r.video.thumbnailUrl && <img src={r.video.thumbnailUrl} alt="" className="h-full w-full object-cover opacity-60 grayscale" />}</div>
              <div className="min-w-0 flex-1 text-[14px]">
                <p className="text-[16px] font-semibold">{r.video.title}</p>
                <p className="mt-1 flex items-center gap-1.5 font-medium text-danger"><Icon.Warning size={16} />{t('notices.removedOn', { date: fullDate(r.takenDownAt, locale) })} {r.reason === 'COPYRIGHT' ? t('hub.copyrightNotice') : r.reasonLabel}</p>
                {r.notice && <p className="mt-2"><span className="text-muted">{t('notices.from')}</span> {r.notice.claimantName}<br /><span className="text-muted">{t('notices.work')}</span> {r.notice.originalWork}{r.notice.details && <><br /><span className="text-muted">{t('notices.infringes')}</span> {r.notice.details}</>}</p>}
                {r.moderatorNote && <p className="mt-2"><span className="text-muted">{t('notices.modNote')}</span> {r.moderatorNote}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {r.canCounter && <button type="button" className={buttonClass.primary} onClick={() => setCounterFor(r)}>{t('notices.sendCounter')}</button>}
                  {r.counter && <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-brand"><Icon.Clock size={15} />{t('notices.counterSent', { date: fullDate(r.counter.submittedAt, locale) })}</span>}
                  {r.reason !== 'COPYRIGHT' && <span className="text-[13px] text-muted">{t('notices.askReview')}</span>}
                </div>
              </div>
            </div>
          </article>
        ))}
      {counterFor && <CounterNotice r={counterFor} onClose={() => setCounterFor(null)} onSent={() => { setCounterFor(null); void load(); }} />}
    </div>
  );
}

function CounterNotice({ r, onClose, onSent }: { r: Removal; onClose: () => void; onSent: () => void }) {
  const [statement, setStatement] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [goodFaith, setGoodFaith] = useState(false);
  const [consent, setConsent] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = statement.trim().length >= 20 && name.trim().length >= 3 && address.trim().length >= 8 && goodFaith && consent && signatureMatches(name, signature);
  const send = async () => {
    setBusy(true); setError(null);
    try { await api(`/hub/notices/${r.notice!.id}/counter`, { body: { statement, name, address, goodFaith, consent, signature } }); onSent(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Counter-notice" wide
      footer={<><button type="button" className={buttonClass.quiet} onClick={onClose}>Cancel</button><button type="button" className={buttonClass.primary} disabled={!ready || busy} onClick={send}>{busy && <Icon.Spinner size={14} className="animate-spin" />}Send counter-notice</button></>}>
      <div className="space-y-4 text-[14px]">
        <p className="rounded-xl bg-surface p-3 text-muted">Send this only if you believe <strong className="text-ink">&ldquo;{r.video.title}&rdquo;</strong> was removed by mistake or misidentification, for example because you own the work, have a licence, or your use is allowed by law. We forward your name, address and statement to {r.notice!.claimantName}. False statements can make you liable for damages.</p>
        <label className="block font-medium">Why the removal was a mistake<textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={4} maxLength={3000} placeholder="Explain what you own or the permission you have." className={`${inputClass} mt-1`} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block font-medium">Full legal name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={`${inputClass} mt-1`} /></label>
          <label className="block font-medium">Postal address<input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" className={`${inputClass} mt-1`} /></label>
        </div>
        <label className="flex gap-3"><input type="checkbox" checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} className="mt-1 accent-[var(--brand)]" /><span>I swear, under penalty of perjury, that I have a good-faith belief the video was removed as a result of a mistake or misidentification of the material.</span></label>
        <label className="flex gap-3"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 accent-[var(--brand)]" /><span>I consent to the jurisdiction of the courts for my address (or, outside the United States, any court where the service operates) and will accept service of process from the person who sent the notice.</span></label>
        <label className="block font-medium">Signature: type your full name<input value={signature} onChange={(e) => setSignature(e.target.value)} className={`${inputClass} mt-1`} />{signature && !signatureMatches(name, signature) && <span className="mt-1 block text-[12px] font-normal text-danger">Type your name exactly as above.</span>}</label>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
