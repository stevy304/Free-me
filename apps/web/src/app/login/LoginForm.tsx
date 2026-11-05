'use client';

import Link from 'next/link';
import * as Icon from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/Logo';
import { api, ApiError } from '@/lib/client-api';

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function LoginForm({ returnTo, google, initialError }: { returnTo: string; google: boolean; initialError: string | null }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [wait, setWait] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);
  useEffect(() => { if (step === 'code') codeInput.current?.focus(); }, [step]);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ email: string }>('/auth/email/request', { body: { email } });
      setEmail(r.email); setStep('code'); setCode(''); setWait(60);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the code.');
      if (e instanceof ApiError && e.retryAfterSeconds && step === 'code') setWait(e.retryAfterSeconds);
    } finally { setBusy(false); }
  };
  const verify = async (value = code) => {
    if (value.length !== 6) return;
    setBusy(true); setError(null);
    try {
      await api('/auth/email/verify', { body: { email, code: value } });
      window.location.href = returnTo;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sign in.'); setBusy(false); }
  };

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px] rounded-3xl border border-line bg-elevated p-8 sm:p-10">
        <LogoMark size={40} />
        {step === 'email' ? (
          <>
            <h1 className="mt-5 text-[26px] font-semibold tracking-tight">Sign in to Free Me</h1>
            <p className="mt-1.5 text-[15px] text-muted">Watch, follow and create. New here? Signing in creates your account.</p>
            {error && <p role="alert" className="mt-5 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
            {google && (
              <>
                <a href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`} className="mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full border border-line text-[15px] font-medium hover:bg-surface">
                  <GoogleIcon />Continue with Google
                </a>
                <div className="my-6 flex items-center gap-3 text-[13px] text-faint"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
              </>
            )}
            <form className={google ? '' : 'mt-6'} onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <label htmlFor="email" className="text-[14px] font-medium">Email address</label>
              <input id="email" type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                className="mt-2 h-12 w-full rounded-xl border border-line bg-bg px-4 text-[16px] outline-none focus:border-brand" />
              <button type="submit" disabled={busy || !email} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-strong text-[15px] font-medium text-on-strong hover:opacity-90 disabled:opacity-50">
                {busy ? <Icon.Spinner size={18} className="animate-spin" /> : <Icon.Mail size={18} />}Email me a sign-in code
              </button>
            </form>
            <p className="mt-6 text-[12px] leading-5 text-faint">No password needed. We send a one-time code that works for ten minutes.</p>
          </>
        ) : (
          <>
            <button type="button" onClick={() => { setStep('email'); setError(null); }} className="mt-4 flex items-center gap-1 text-[14px] text-muted hover:text-ink"><Icon.ArrowLeft size={16} />Use another email</button>
            <h1 className="mt-3 text-[26px] font-semibold tracking-tight">Check your email</h1>
            <p className="mt-1.5 text-[15px] text-muted">We sent a 6-digit code to <span className="font-medium text-ink">{email}</span>.</p>
            {error && <p role="alert" className="mt-5 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
            <form className="mt-6" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
              <label htmlFor="code" className="text-[14px] font-medium">Sign-in code</label>
              <input id="code" ref={codeInput} value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}"
                onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) void verify(v); }}
                className="mt-2 h-14 w-full rounded-xl border border-line bg-bg px-4 text-center font-mono text-[28px] tracking-[0.5em] outline-none focus:border-brand" placeholder="••••••" />
              <button type="submit" disabled={busy || code.length !== 6} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-strong text-[15px] font-medium text-on-strong hover:opacity-90 disabled:opacity-50">
                {busy && <Icon.Spinner size={18} className="animate-spin" />}Sign in
              </button>
            </form>
            <button type="button" disabled={wait > 0 || busy} onClick={() => void send()} className="mt-5 text-[14px] font-medium text-brand disabled:text-faint">
              {wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
            </button>
          </>
        )}
        <p className="mt-8 text-[12px] leading-5 text-muted">By continuing you agree to the <Link href="/legal/terms" className="text-brand">Terms of Service</Link> and confirm you have read the <Link href="/legal/privacy" className="text-brand">Privacy Policy</Link>.</p>
      </div>
    </div>
  );
}
