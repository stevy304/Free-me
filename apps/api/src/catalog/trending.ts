import { Prisma, type PrismaClient } from '@prisma/client';
import { PUBLIC_VIDEO } from './serialize';

/**
 * Trending: public videos (not Moments) published in the last 30 days, ranked by views in the last two days, so a
 * video rising now beats one that was big last month. With `country`, only Spaces whose owner chose that country
 * (local creators). Falls back to the most watched recent videos while there is no recent view data yet.
 */
export async function trendingVideos(prisma: PrismaClient, opts: { country?: string | null; take: number }) {
  const country = opts.country && /^[A-Z]{2}$/.test(opts.country) ? opts.country : null;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const ranked = await prisma.$queryRaw<Array<{ videoId: string; views: bigint }>>`
    SELECT s."videoId", sum(s."views")::bigint AS views
    FROM "VideoDailyStat" s JOIN "Video" v ON v."id" = s."videoId"
    ${country ? Prisma.sql`JOIN "Channel" c ON c."id" = v."channelId" JOIN "Profile" p ON p."userId" = c."userId" AND p."country" = ${country}` : Prisma.empty}
    WHERE s."day" >= (current_date - 1) AND v."publishedAt" >= ${since} AND v."isShort" = false
    GROUP BY s."videoId" HAVING sum(s."views") > 0 ORDER BY views DESC LIMIT ${opts.take * 2}`;
  const include = { channel: true } as const;
  const local = country ? { channel: { user: { profile: { country } } } } : {};
  const rows = ranked.length ? await prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false, id: { in: ranked.map((r) => r.videoId) } }, include }) : [];
  const order = new Map(ranked.map((r, i) => [r.videoId, i]));
  const videos = rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).slice(0, opts.take);
  if (videos.length >= opts.take) return videos;
  // Not enough recent views (a new platform, a small country): fill with the most watched recent videos.
  const more = await prisma.video.findMany({
    where: { ...PUBLIC_VIDEO, ...local, isShort: false, publishedAt: { gte: since }, id: { notIn: videos.map((v) => v.id) } },
    orderBy: [{ viewCount: 'desc' }, { publishedAt: 'desc' }], take: opts.take - videos.length, include,
  });
  return [...videos, ...more];
}

/**
 * "People who watched this also watched": among the latest 500 signed-in viewers of a video, how many watched
 * each other video. Only counts shared by at least 3 people are used, so no one's own history can be read from it.
 */
export async function coWatched(prisma: PrismaClient, videoId: string, limit = 40): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ videoId: string; n: number }>>`
    WITH viewers AS (SELECT "userId" FROM "WatchHistory" WHERE "videoId" = ${videoId} ORDER BY "lastWatchedAt" DESC LIMIT 500)
    SELECT h."videoId", count(*)::int AS n FROM "WatchHistory" h JOIN viewers w ON w."userId" = h."userId"
    WHERE h."videoId" <> ${videoId} GROUP BY h."videoId" HAVING count(*) >= 3 ORDER BY n DESC LIMIT ${limit}`;
  return new Map(rows.map((r) => [r.videoId, r.n]));
}
