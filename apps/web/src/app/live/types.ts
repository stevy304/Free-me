import type { Poll } from '@/components/live/LivePoll';

export interface LiveInfo {
  id: string; title: string; status: 'IDLE' | 'LIVE' | 'ENDED'; startedAt: string | null; endedAt: string | null; playbackUrl: string | null; viewers: number; peakViewers: number; replayVideoId: string | null;
  description?: string | null; scheduledFor?: string | null; captionsEnabled?: boolean;
  chat?: { mode: 'everyone' | 'followers' | 'off'; slowModeSeconds: number };
  latencyMode?: 'normal' | 'low';
  poll?: Poll | null;
  channel: { handle: string; name: string; avatarUrl: string | null; isVerified: boolean };
}
