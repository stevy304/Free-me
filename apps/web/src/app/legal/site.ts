import { apiGet } from '@/lib/server-api';

export interface SiteInfo { operatorName: string; contactEmail: string | null; copyrightEmail: string | null; postalAddress: string | null; jurisdiction: string | null }

/** Who runs the service and how to reach them, from the API configuration (LEGAL_* settings). */
export async function siteInfo(): Promise<SiteInfo> {
  return (await apiGet<SiteInfo>('/site')) ?? { operatorName: 'Free Me', contactEmail: null, copyrightEmail: null, postalAddress: null, jurisdiction: null };
}

export const LAST_UPDATED = '5 November 2026';
