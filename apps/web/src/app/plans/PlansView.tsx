'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { charge, money, usd } from '@/lib/money';
import type { Payment, PlanPrice, Plans } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

interface Me {
  plans: {
    plus: { active: boolean; until: string | null; via: 'plus' | 'family' | 'family_member' | 'premium' | null };
    family: { active: boolean; until: string | null; memberOf: { email: string | null; until: string | null } | null };
    creatorPass: { active: boolean; until: string | null };
  };
  premium: { active: boolean };
}
interface Family { holder: { active: boolean; until: string | null; seats: number; members: Array<{ id: string; email: string; name: string | null }> }; memberOf: { email: string | null; until: string | null } | null }
type Buyable = 'plus' | 'family';

/** All plans in one place: compare, buy Plus or Family & TV here, and manage the family. */
export function PlansView({ signedIn }: { signedIn: boolean }) {
  const { locale } = useShell();
  const router = useRouter();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  const [choice, setChoice] = useState<Buyable | null>(null);
  const [months, setMonths] = useState(1);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlans(await api<Plans>('/billing/plans'));
      if (signedIn) { const [m, f] = await Promise.all([api<Me>('/billing/me'), api<Family>('/billing/family')]); setMe(m); setFamily(f); }
    } catch (e) { setError((e as Error).message); }
  }, [signedIn]);
  useEffect(() => { void load(); }, [load]);

  const paid = useCallback((p: Payment) => {
    if (p.status === 'SUCCEEDED') { setNotice(p.purpose === 'FAMILY' ? 'Family & TV is active. Add the people you share it with below.' : 'Plus is active: no ads and every quality.'); setChoice(null); void load(); router.refresh(); }
    else setError(p.failureReason ?? 'The payment did not go through.');
  }, [load, router]);
  const { watching, watch } = usePaymentWatch(paid);
  useEffect(() => {
    const id = params.get('payment');
    if (id && signedIn && !watching) api<{ payment: Payment }>(`/billing/payments/${id}`).then((r) => (r.payment.status === 'PENDING' ? watch(r.payment) : paid(r.payment))).catch(() => undefined);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const familyCall = async (fn: () => Promise<Family>) => { setError(null); try { setFamily(await fn()); setEmail(''); } catch (e) { setError((e as Error).message); } };
  const choose = (k: Buyable) => { if (!signedIn) { router.push('/login?returnTo=/plans'); return; } setChoice(k); setMonths(1); setError(null); };

  if (!plans) return error ? <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const until = (d: string | null) => (d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  // Mobile money charges in francs (or another local currency): show that amount, the one people will pay.
  const local = plans.methods.find((m) => m.currency !== 'USD' && (m.name === 'mtn_momo' || m.name === 'airtel_money'));
  const price = (p: PlanPrice | undefined, per: string) => p && (
    <p className="mt-2"><b className="font-display text-[26px] font-extrabold">{local && p.country ? money(charge(p.usdCents, local), local.currency, locale) : usd(p.usdCents, locale)}</b> <span className="text-[14px] text-muted">{per}</span>
      {local && !p.country && <span className="block text-[12px] text-muted">{money(charge(p.usdCents, local), local.currency, locale)} by mobile money</span>}
      {p.country && p.standardUsdCents && <span className="block text-[12px] text-muted">Your price in {region(p.country, locale)} ({usd(p.standardUsdCents, locale)} elsewhere)</span>}</p>
  );
  const status = (active: boolean, text: string) => active && <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-[12px] font-semibold text-brand"><Icon.CheckCircle size={14} filled />{text}</p>;
  const buying = choice && plans[choice];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      <h1 className="font-display text-[32px] font-extrabold">Plans</h1>
      <p className="text-[15px] text-muted">Watching is free. Pay only for what you want more of. Pay with MTN MoMo, Airtel Money or a card; plans are paid ahead and never renew without you.</p>
      {notice && <p role="status" className="mt-4 flex items-center gap-2 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand"><Icon.CheckCircle size={20} filled />{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
      {watching?.status === 'PENDING' && watching.method !== 'manual' && <p role="status" className="mt-4 flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-[14px]"><Icon.Spinner size={18} className="animate-spin" />Confirming your payment…</p>}

      <h2 className="mt-8 font-display text-[22px] font-bold">For viewers</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Free" tag="Watch">
          <p className="mt-2"><b className="font-display text-[26px] font-extrabold">{usd(0, locale)}</b></p>
          <Perks items={['Watch everything, with short ads', 'Video quality up to 720p', 'Follow, comment and save videos']} />
        </Card>

        <Card title="Plus" tag="Watch without ads" highlight>
          {price(plans.plus, 'a month')}
          {status(!!me?.plans.plus.active, me?.plans.plus.via === 'plus' ? `Active until ${until(me.plans.plus.until)}` : 'Included in your plan')}
          <Perks items={['No ads', 'Video quality up to 1080p and 4K', 'On your phone, computer and smart TV']} />
          <Choose onClick={() => choose('plus')} label={me?.plans.plus.via === 'plus' ? 'Add more time' : 'Get Plus'} />
        </Card>

        <Card title="Family & TV" tag="For the whole home">
          {plans.family && price(plans.family, 'a month')}
          {status(!!me?.plans.family.active, `Active until ${until(me?.plans.family.until ?? null)}`)}
          <Perks items={[`Everything in Plus for up to ${plans.family?.seats ?? 4} people`, 'Watch on a smart TV’s browser and every phone at home', 'Add and remove people any time']} />
          <Choose onClick={() => choose('family')} label={me?.plans.family.active ? 'Add more time' : 'Get Family & TV'} />
        </Card>
      </div>

      <h2 className="mt-10 font-display text-[22px] font-bold">For creators</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Starter" tag="Try creating">
          <p className="mt-2"><b className="font-display text-[26px] font-extrabold">{usd(0, locale)}</b></p>
          <Perks items={[`${plans.creatorPass?.freeVideos ?? 3} uploads`, `Videos up to ${Math.round((plans.uploadMaxBytes ?? 20 * 1024 ** 3) / 1024 ** 3)} GB each`, '1080p and 4K once your videos take off', 'Creator Hub with your stats']} />
        </Card>

        <Card title="Creator pass" tag="Keep creating">
          {price(plans.creatorPass, 'a year')}
          {status(!!me?.plans.creatorPass.active, `Active until ${until(me?.plans.creatorPass.until ?? null)}`)}
          <Perks items={[`${plans.creatorPass?.videosPerYear ?? 50} uploads a year`, `Videos up to ${Math.round((plans.uploadMaxBytes ?? 20 * 1024 ** 3) / 1024 ** 3)} GB each`, '1080p and 4K once your videos take off', 'Your videos stay online even if the pass ends']} />
          <Link href="/hub/pass" className="mt-4 flex h-11 items-center justify-center rounded-2xl bg-brand text-[14px] font-bold text-on-brand hover:bg-brand-strong">Get the Creator pass</Link>
        </Card>

        <Card title="Pro" tag="Grow and earn" badge highlight>
          {price(plans.premium, 'a month')}
          {status(!!me?.premium.active, 'Active')}
          <Perks items={['Unlimited uploads', '1080p and 4K from the first minute', 'Live streaming', 'Earn from your videos', 'Gold Premium badge', 'No ads when you watch']} />
          <Link href="/premium" className="mt-4 flex h-11 items-center justify-center rounded-2xl bg-brand text-[14px] font-bold text-on-brand hover:bg-brand-strong">Get Pro</Link>
        </Card>
      </div>
      <p className="mt-6 text-[14px] text-muted">A business? Advertise and protect your name with a Verified badge in <Link href="/studio/ads" className="font-semibold text-brand">Ad Studio</Link>.</p>

      {buying && choice && (
        <section aria-labelledby="checkout" className="mt-8 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <h2 id="checkout" className="flex-1 font-display text-[20px] font-bold">{choice === 'plus' ? 'Plus' : 'Family & TV'}: choose how long</h2>
            <button type="button" onClick={() => setChoice(null)} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={20} /></button>
          </div>
          <div role="radiogroup" aria-label="Length" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {buying.months.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)}
                className={`rounded-2xl border-2 px-3 py-2.5 text-left ${months === m ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
                <span className="block text-[15px] font-bold">{m} {m === 1 ? 'month' : 'months'}</span>
                <span className="block text-[13px] text-muted">{usd(buying.usdCents * m, locale)}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 max-w-lg">
            <PayPanel usdCents={buying.usdCents * months} plans={plans} label={choice === 'plus' ? 'Get Plus' : 'Get Family & TV'} onPaid={paid}
              start={async (method, phone) => (await api<{ payment: Payment }>(`/billing/plans/${choice}`, { body: { method, phone, months } })).payment} />
          </div>
        </section>
      )}

      {family?.holder.active && (
        <section aria-labelledby="family" className="mt-8 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
          <h2 id="family" className="font-display text-[20px] font-bold">Your family</h2>
          <p className="text-[14px] text-muted">Up to {family.holder.seats - 1} more people, by the email of their Free Me account. They get Plus while your plan lasts.</p>
          <ul className="mt-3 divide-y divide-line">
            {family.holder.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[15px]">{m.name ? `${m.name} · ` : ''}{m.email}</span>
                <button type="button" onClick={() => void familyCall(() => api<Family>(`/billing/family/members/${m.id}`, { method: 'DELETE', body: {} }))} className="text-[13px] font-semibold text-danger hover:underline">Remove</button>
              </li>
            ))}
            {!family.holder.members.length && <li className="py-2.5 text-[14px] text-muted">Nobody added yet.</li>}
          </ul>
          {family.holder.members.length < family.holder.seats - 1 && (
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void familyCall(() => api<Family>('/billing/family/members', { body: { email } })); }}>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their@email.com" className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand" />
              <button type="submit" className="h-11 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Add</button>
            </form>
          )}
        </section>
      )}

      {family?.memberOf && (
        <section className="mt-8 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
          <p className="text-[15px]">You are in <b>{family.memberOf.email}</b>&rsquo;s Family & TV plan{family.memberOf.until ? `, until ${until(family.memberOf.until)}` : ''}.</p>
          <button type="button" onClick={() => void familyCall(() => api<Family>('/billing/family/membership', { method: 'DELETE', body: {} }))} className="mt-2 text-[13px] font-semibold text-danger hover:underline">Leave this plan</button>
        </section>
      )}
    </div>
  );
}

function Card({ title, tag, highlight, badge, children }: { title: string; tag: string; highlight?: boolean; badge?: boolean; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col rounded-3xl border p-5 ${highlight ? 'border-brand bg-brand-soft/40' : 'border-line bg-elevated'}`}>
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{tag}</p>
      <h2 className="mt-1 flex items-center gap-2 font-display text-[22px] font-bold">{title}{badge && <VerifiedBadge size={20} kind="premium" />}</h2>
      {children}
    </section>
  );
}
function Perks({ items }: { items: string[] }) {
  return <ul className="mt-3 flex-1 space-y-1.5 text-[14px]">{items.map((t) => <li key={t} className="flex gap-2"><Icon.Check size={16} className="mt-0.5 shrink-0 text-brand" />{t}</li>)}</ul>;
}
function Choose({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" onClick={onClick} className="mt-4 h-11 rounded-2xl bg-brand text-[14px] font-bold text-on-brand hover:bg-brand-strong">{label}</button>;
}
function region(code: string, locale: string) {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code; } catch { return code; }
}
