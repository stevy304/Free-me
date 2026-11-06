export interface LiveInfo {
  id: string; title: string; status: 'IDLE' | 'LIVE' | 'ENDED'; startedAt: string | null; endedAt: string | null; playbackUrl: string | null; viewers: number; peakViewers: number; replayVideoId: string | null;
  channel: { handle: string; name: string; avatarUrl: string | null; isVerified: boolean };
}
