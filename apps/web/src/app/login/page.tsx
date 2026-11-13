import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiGet, getT, getViewer } from '@/lib/server-api';
import type { Key } from '@/i18n';
import { LoginForm } from './LoginForm';

export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('header.signIn') }; }

const ERRORS: Record<string, Key> = {
  google_unavailable: 'login.eGoogleUnavailable',
  google_cancelled: 'login.eGoogleCancelled',
  google_expired: 'login.eGoogleExpired',
  google_failed: 'login.eGoogleFailed',
  google_unverified: 'login.eGoogleUnverified',
  account_suspended: 'login.eSuspended',
};

const safe = (v?: string) => (v && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/');

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; error?: string }> }) {
  const { returnTo, error } = await searchParams;
  const back = safe(returnTo);
  if (await getViewer()) redirect(back);
  const t = await getT();
  const providers = (await apiGet<{ google: boolean }>('/auth/providers')) ?? { google: false };
  return <LoginForm returnTo={back} google={providers.google} initialError={error ? t(ERRORS[error] ?? 'login.eGeneric') : null} />;
}
