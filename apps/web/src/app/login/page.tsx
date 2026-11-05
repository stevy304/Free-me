import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiGet, getViewer } from '@/lib/server-api';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  google_unavailable: 'Google sign-in is not available right now. Use an email code instead.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_expired: 'The Google sign-in took too long or was opened in another browser. Please try again.',
  google_failed: 'Google sign-in did not work. Please try again, or use an email code.',
  google_unverified: 'Your Google account email is not verified. Use an email code instead.',
  account_suspended: 'This account is suspended. Contact support if you think this is a mistake.',
};

const safe = (v?: string) => (v && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/');

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; error?: string }> }) {
  const { returnTo, error } = await searchParams;
  const back = safe(returnTo);
  if (await getViewer()) redirect(back);
  const providers = (await apiGet<{ google: boolean }>('/auth/providers')) ?? { google: false };
  return <LoginForm returnTo={back} google={providers.google} initialError={error ? ERRORS[error] ?? 'Sign-in did not work. Please try again.' : null} />;
}
