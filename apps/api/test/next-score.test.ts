import { scoreNext } from '../src/catalog/next.controller';

const now = Date.now();
const video = (over: Record<string, unknown>) => ({ id: 'x', channelId: 'a', categoryId: null, language: null, viewCount: 0n, likeCount: 0, publishedAt: new Date(now), tags: [], ...over }) as never;
const ctx = (viewCount: number, coWatch: Map<string, number>) => ({ current: video({ id: 'cur', viewCount: BigInt(viewCount) }), tagIds: new Set<string>(), interests: new Set<string>(), finished: new Set<string>(), started: new Set<string>(), now, coWatch });

test('Next: what most of a video\'s viewers go on to watch beats another video from the same Space', () => {
  const sameSpace = video({ id: 'same', channelId: 'a' });
  const together = video({ id: 'together', channelId: 'b', viewCount: 3n });
  // 3 of 3 viewers watched it next: it comes first.
  const small = ctx(3, new Map([['together', 3]]));
  expect(scoreNext(together, small)).toBeGreaterThan(scoreNext(sameSpace, small));
  // 3 of 500 recent viewers is a weak sign: the same Space still comes first.
  const big = ctx(100_000, new Map([['together', 3]]));
  expect(scoreNext(together, big)).toBeLessThan(scoreNext(sameSpace, big));
});
