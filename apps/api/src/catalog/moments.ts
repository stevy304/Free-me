import type { PrismaClient } from '@prisma/client';
import { PUBLIC_VIDEO } from './serialize';

/**
 * What the Moments feed shows over each Moment, besides the card: its description, tags, the sound it uses and, for an
 * episode, its place in the series. Fetched for a page of Moments at once.
 *
 * The sound: a licensed work when Content ID matched it by sound to a verified rights holder who lets it be used (earn
 * or track), else what the creator named it, else the creator's original sound.
 */
export type MomentSound = { kind: 'original' } | { kind: 'named'; title: string } | { kind: 'licensed'; title: string; owner: string };
export interface MomentDetails {
  description: string | null;
  tags: string[];
  sound: MomentSound;
  series: { id: string; title: string; episode: number; count: number; nextId: string | null } | null;
}

const DESCRIPTION_MAX = 600;

export async function momentDetails(prisma: PrismaClient, videos: Array<{ id: string; description: string | null; soundTitle: string | null; seriesId: string | null; episodeNumber: number | null }>): Promise<Map<string, MomentDetails>> {
  const ids = videos.map((v) => v.id);
  const seriesIds = [...new Set(videos.map((v) => v.seriesId).filter((x): x is string => !!x))];
  const [tags, claims, series, episodes] = await Promise.all([
    prisma.videoTag.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, tag: { select: { name: true } } } }),
    prisma.contentClaim.findMany({
      where: { videoId: { in: ids }, status: { not: 'RELEASED' }, policy: { in: ['MONETIZE', 'TRACK'] }, matched: { contains: 'sound' } },
      select: { videoId: true, reference: { select: { title: true } }, owner: { select: { handle: true } } }, orderBy: { matchedSeconds: 'desc' },
    }),
    seriesIds.length ? prisma.series.findMany({ where: { id: { in: seriesIds } }, select: { id: true, title: true } }) : [],
    // Only published episodes count and can come next. A series is at most a few hundred Moments.
    seriesIds.length ? prisma.video.findMany({ where: { seriesId: { in: seriesIds }, ...PUBLIC_VIDEO }, select: { id: true, seriesId: true, episodeNumber: true }, orderBy: [{ episodeNumber: 'asc' }, { publishedAt: 'asc' }], take: 2000 }) : [],
  ]);
  const titles = new Map(series.map((s) => [s.id, s.title]));
  const out = new Map<string, MomentDetails>();
  for (const v of videos) {
    const claim = claims.find((c) => c.videoId === v.id);
    const sound: MomentSound = claim ? { kind: 'licensed', title: claim.reference.title, owner: claim.owner.handle }
      : v.soundTitle ? { kind: 'named', title: v.soundTitle } : { kind: 'original' };
    let s: MomentDetails['series'] = null;
    if (v.seriesId && titles.has(v.seriesId)) {
      const list = episodes.filter((e) => e.seriesId === v.seriesId);
      const at = list.findIndex((e) => e.id === v.id);
      s = { id: v.seriesId, title: titles.get(v.seriesId)!, episode: v.episodeNumber ?? at + 1, count: list.length, nextId: at >= 0 ? list[at + 1]?.id ?? null : null };
    }
    const d = v.description?.trim() || null;
    out.set(v.id, {
      description: d && d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX).trimEnd()}…` : d,
      tags: tags.filter((t) => t.videoId === v.id).map((t) => t.tag.name).slice(0, 6),
      sound,
      series: s,
    });
  }
  return out;
}
