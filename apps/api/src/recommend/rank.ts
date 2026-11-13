/**
 * The ranking step of "For you" (see ALGORITHM.md): pure functions, no I/O, so every rule can be tested on its own.
 *
 * 1. Candidates come from several sources (related to what you watched, Spaces you follow, your topics, trending,
 *    new uploads, the best of the catalogue), a few hundred at most.
 * 2. `score` gives each one a number from what is known about the video (quality, freshness, momentum) and about
 *    you (taste profile), and remembers which part counted most: that becomes the reason shown on the card.
 * 3. `arrange` orders them, keeping a mix (Spaces and topics do not repeat back to back) and keeping places for
 *    new creators, so a Space with no audience yet can still be found.
 */

/** What is known about a video, from the feature store (recommend/signals.ts). */
export interface Features {
  id: string; channelId: string; categoryId: string | null; tagIds: string[]; language: string | null; country: string | null;
  publishedAt: number; durationSeconds: number; isShort: boolean;
  /** 0..1: how much of it people watch and how they react (signals.ts). */
  quality: number;
  /** Views in the last two days, and in total. */
  recentViews: number; views: number;
}

/** What is known about the viewer (recommend/profile.ts). Weights are 0..1, 1 being the strongest. */
export interface Taste {
  topics: Record<string, number>; channels: Record<string, number>; tags: Record<string, number>;
  /** Picked topics and followed Spaces (always used, even with personalisation off). */
  picked: string[]; follows: string[];
  /** Spaces and topics the viewer said "Not for me" to. */
  avoidChannels: Record<string, number>; avoidTopics: Record<string, number>;
  /** Videos never to show again ("Not for me"), finished, and started but not finished. */
  hidden: string[]; finished: string[]; started: string[];
  /** Recently watched videos, newest first: their related videos are candidates. */
  seeds: string[];
  language: string | null; country: string | null;
}

export type Source = 'related' | 'following' | 'topic' | 'trending' | 'fresh' | 'quality';
export interface Candidate extends Features {
  sources: Set<Source>;
  /** 0..1: how strongly it is related to something the viewer watched, and to which video. */
  related: number; relatedTo: string | null;
}

export type Reason =
  | { kind: 'related'; videoId: string }
  | { kind: 'following' }
  | { kind: 'topic'; categoryId: string }
  | { kind: 'trending' }
  | { kind: 'new' }
  | { kind: 'popular' };

export interface Scored extends Candidate { score: number; reason: Reason }

const DAY = 86_400_000;
/** The weights. Tuned by hand to start with; ALGORITHM.md says how to tune them from what people watch. */
export const W = {
  related: 3.0, following: 1.6, channel: 2.2, topic: 1.8, picked: 0.8, tags: 1.0, quality: 1.6, momentum: 0.7, fresh: 1.0,
  language: 0.4, country: 0.3, avoidChannel: 2.5, avoidTopic: 1.0, finished: 5, started: 1.5, seen: 0.8,
};

/** A number from 0 to 1 that only depends on the video and the hour: a little variety that stays put while paging. */
export function jitter(id: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * One candidate's score and the reason it is shown. Every part is bounded, so no single signal (a huge view count, one
 * strong tag) can push everything else aside.
 */
/** The viewer's lists as sets, made once per ranking (scoring looks them up for every candidate). */
export interface TasteSets { follows: Set<string>; picked: Set<string>; finished: Set<string>; started: Set<string> }
export const tasteSets = (t: Taste): TasteSets => ({ follows: new Set(t.follows), picked: new Set(t.picked), finished: new Set(t.finished), started: new Set(t.started) });

export function score(c: Candidate, t: Taste, ctx: { now: number; seen?: Record<string, number>; seed?: number; sets?: TasteSets }): Scored {
  // Plain numbers, no objects per part: this runs for every candidate of every feed (about a thousand each time).
  const sets = ctx.sets ?? tasteSets(t);
  const follows = sets.follows.has(c.channelId);
  const related = W.related * c.related;
  const channel = (follows ? W.following : 0) + W.channel * (t.channels[c.channelId] ?? 0);
  const topic = c.categoryId ? W.topic * (t.topics[c.categoryId] ?? 0) + (sets.picked.has(c.categoryId) ? W.picked : 0) : 0;
  let tagMatch = 0;
  for (const id of c.tagIds) tagMatch += t.tags[id] ?? 0;
  const tags = W.tags * Math.min(1, tagMatch / 2);
  const quality = W.quality * c.quality;
  // Momentum: views in the last two days, on a log scale (10 → 0.33, 1,000 → 1).
  const momentum = W.momentum * Math.min(1, Math.log10(1 + c.recentViews) / 3);
  const ageDays = Math.max(0, (ctx.now - c.publishedAt) / DAY);
  const fresh = W.fresh * Math.exp(-ageDays / 7);
  const local = (t.language && c.language === t.language ? W.language : 0) + (t.country && c.country === t.country ? W.country : 0);

  let s = related + channel + topic + tags + quality + momentum + fresh + local;
  s -= W.avoidChannel * (t.avoidChannels[c.channelId] ?? 0);
  if (c.categoryId) s -= W.avoidTopic * (t.avoidTopics[c.categoryId] ?? 0);
  if (sets.finished.has(c.id)) s -= W.finished;
  else if (sets.started.has(c.id)) s -= W.started; // already in "Continue watching"
  // Shown recently and not opened: a little lower each time, so the feed moves on.
  s -= W.seen * Math.min(3, ctx.seen?.[c.id] ?? 0);
  s += 0.3 * jitter(c.id, ctx.seed ?? 0);

  // The reason: the biggest personal part when it is strong enough, else what the video itself has going for it.
  const topicPart = topic + tags;
  let reason: Reason;
  const personal = Math.max(related, follows ? channel : 0, c.categoryId ? topicPart : 0);
  if (personal >= 0.8 && personal === related && c.relatedTo) reason = { kind: 'related', videoId: c.relatedTo };
  else if (personal >= 0.8 && follows && personal === channel) reason = { kind: 'following' };
  else if (personal >= 0.8 && c.categoryId && personal === topicPart) reason = { kind: 'topic', categoryId: c.categoryId };
  else {
    const best = Math.max(quality + local, momentum, fresh, topicPart, related);
    reason = best === momentum ? { kind: 'trending' } : best === fresh ? { kind: 'new' }
      : best === topicPart && c.categoryId ? { kind: 'topic', categoryId: c.categoryId }
      : best === related && c.relatedTo ? { kind: 'related', videoId: c.relatedTo } : { kind: 'popular' };
  }
  if (c.sources.has('fresh') && ageDays < 7 && c.views < 100 && reason.kind === 'popular') reason = { kind: 'new' };
  const out = c as Scored;
  out.score = s; out.reason = reason;
  return out;
}

/**
 * The final order. Highest score first, with three rules:
 * - a Space appears at most once in any 4 cards in a row, a topic at most twice in any 5;
 * - every `exploreEvery`-th place goes to the best new video (under 7 days, under 100 views) not placed yet, so new
 *   creators get seen and the platform learns whether people like them;
 * - videos never to show again are left out.
 */
export function arrange(scored: Scored[], t: Pick<Taste, 'hidden'>, opts: { limit: number; exploreEvery?: number; now: number }): Scored[] {
  const every = opts.exploreEvery ?? 6;
  const hidden = new Set(t.hidden);
  const rest = scored.filter((c) => !hidden.has(c.id)).sort((a, b) => b.score - a.score);
  const isNew = (c: Scored) => opts.now - c.publishedAt < 7 * DAY && c.views < 100;
  const out: Scored[] = [];
  const fits = (c: Scored) => {
    if (out.slice(-3).some((o) => o.channelId === c.channelId)) return false;
    return !c.categoryId || out.slice(-4).filter((o) => o.categoryId === c.categoryId).length < 2;
  };
  while (out.length < opts.limit && rest.length) {
    const exploring = every > 0 && out.length % every === every - 1;
    let i = exploring ? rest.findIndex((c) => isNew(c) && fits(c)) : -1;
    if (i < 0) i = rest.findIndex(fits);
    if (i < 0) i = 0; // nothing fits the mix rules: take the best anyway rather than stop
    const [c] = rest.splice(i, 1);
    out.push(exploring && isNew(c) && c.reason.kind === 'popular' ? { ...c, reason: { kind: 'new' } } : c);
  }
  return out;
}
