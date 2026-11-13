# How Free Me recommends videos

This page describes the whole recommendation system: what it uses, how it decides, and how it keeps working at
100 million viewers. The code is in `apps/api/src/recommend/` (For you), `apps/api/src/catalog/next.controller.ts`
(Up next) and `apps/api/src/catalog/trending.ts` (Trending).

## Principles

1. **Watching well beats clicking.** A video is good when people watch most of it and react well, not when many
   people open it. A misleading thumbnail gets clicks and loses viewers in seconds, so it does not rise.
2. **Every card says why it is there** ("Because you watched…", "From a Space you follow", "More Music",
   "New on Free Me"). Nothing is recommended for a reason we would not show.
3. **The viewer is in charge.** "Not for me" hides a video and lowers its Space and topic. Removing a video from
   History, or clearing it, removes its influence. Settings → Recommendations turns history-based picks off; then
   only picked topics and followed Spaces count.
4. **New creators get a fair chance.** Some places in every feed are kept for new uploads with almost no views, so
   the platform can learn whether people like them. Without this, only the already-famous would ever be seen.
5. **Variety.** A Space appears at most once in any 4 cards in a row, and a topic at most twice in any 5.
6. **Privacy.** "People who watched this also watched" only uses counts shared by at least 3 people, so nobody's own
   history can be read from it. Visitors who are not signed in get the same feed as every other visitor.

## The three stages

```
                       every 5 min (worker)                          per request (API)
 Video, VideoDailyStat ───────────────────▶ feature store  ──┐
 WatchHistory, Like    ── every 10 min ───▶ related lists  ──┼─▶ 1. candidates (≈ 300–600)
                                                              │   2. score each against the viewer's taste
 viewer's history,     ── on first request ▶ taste profile ──┘   3. arrange (mix, new-creator places, hidden out)
 likes, follows, topics   (kept 30 min)                              → 120 ranked videos, kept 10 min, 5 pages of 24
```

### 1. Signals, prepared ahead (`recommend/signals.ts`, worker job `rec-signals`, every 5 minutes)

For each video in the active catalogue (published in the last 90 days or watched in the last 7, up to
`REC_ACTIVE_MAX`, default 200,000, most watched first), the worker stores its features in Redis:

| Feature | How |
| --- | --- |
| **Quality** (0–1) | 65% how much of it people watch (watch time ÷ (views × length)), 35% likes vs "Not for me". Both start from a prior worth 5 views (35% watched, even reactions), so one viewer cannot make a new video look perfect or terrible |
| Momentum | Views in the last two days (`VideoDailyStat`) |
| Topic, Space, tags, language, country, length, age | From the video and its Space |

It also builds **pools**, ready-made lists of the best 500 videos by:

- **topic** (`2 × quality + 0.8 × log10(1 + views in 2 days) + freshness`, freshness halving in about 10 days);
- **trending**, everywhere and per country (views in the last two days);
- **fresh** (the last 7 days, the least-seen boosted: where new creators are found);
- **best ever** (`quality × log10(10 + views)`);
- **Moments**, overall and per topic.

Pools are written under a temporary name and renamed, so a request never sees a half-built list.

### 2. Related videos, prepared ahead (`recommend/related.ts`, job `rec-related`, every 10 minutes)

"People who watched this also watched": among the latest 500 signed-in viewers of a video, how many watched each
other video (at least 3 of them). The worker prepares it for the most watched videos and keeps it 12 hours. A video
nobody prepared is computed once on first use and kept, with simultaneous requests waiting for the same computation.

### 3. The viewer's taste (`recommend/profile.ts`, kept 30 minutes)

From their last 200 videos (including positions saved seconds ago, still in Redis):

- each watch counts by **how much of it they watched** (finished = 1, 5% = 0.05) times **how recently**
  (`e^(−days/30)`), towards its topic, its Space and its tags;
- a **Spark** (like) adds to the topic (1) and Space (1.5); **"Not for me"** hides the video and lowers the Space
  (fully after twice) and topic;
- **picked topics** and **followed Spaces** always count;
- the last 10 videos watched at least 30% become **seeds** for related candidates.

Each map is scaled so the strongest is 1. A like, a follow, new topics, the setting, or clearing History forgets the
cached taste, so the next feed reflects it.

### 4. Candidates (`recommend/for-you.ts`)

| Source | How many |
| --- | --- |
| Related to each seed (most recent seeds count most) | up to 8 × 50 |
| The viewer's top 6 topics (and picked ones) | 60 each |
| Followed Spaces, last 30 days | 40 |
| Trending everywhere / in the viewer's country | 80 / 40 |
| Fresh uploads | 60 |
| Best ever | 60 |

No source scans the catalogue: they are Redis reads plus one small indexed query.

### 5. Score (`recommend/rank.ts → score`)

Every part is bounded, so no single signal can take over (a viral video cannot push your interests aside):

| Part | Weight | Value |
| --- | ---: | --- |
| Related to something you watched | 3.0 | 0–1 (co-watchers ÷ the most, × seed recency) |
| Followed Space / your affinity to the Space | 1.6 / 2.2 | 0–1 |
| Your affinity to the topic / you picked it | 1.8 / 0.8 | 0–1 |
| Shared tags | 1.0 | 0–1 |
| Quality | 1.6 | 0–1 |
| Momentum | 0.7 | `log10(1 + views in 2 days) / 3`, at most 1 |
| Freshness | 1.0 | `e^(−days/7)` |
| Your language / country | 0.4 / 0.3 | 0 or 1 |
| "Not for me" Space / topic | −2.5 / −1.0 | 0–1 |
| Finished / started (it is in Continue watching) | −5 / −1.5 | |
| Shown to you and not opened | −0.8 each, up to 3 | from the last 2 days |
| Variety | +0–0.3 | the same within an hour, so pages stay put |

The **reason** shown is the biggest personal part (related, followed Space, topic) when it is strong enough, else
what the video has going for it (watched a lot now, new, viewers watch it to the end).

### 6. Arrange (`recommend/rank.ts → arrange`)

Highest score first, then:

- a Space at most once in any 4 in a row, a topic at most twice in any 5;
- every 6th place goes to the best new video (under 7 days, under 100 views) not yet placed;
- hidden videos ("Not for me") are left out;
- the final page is checked against the database, so a video made private or removed since is never shown.

The 120 ranked videos are kept 10 minutes (2 for visitors) so pages do not reshuffle while scrolling.

## Up next and Trending

- **Up next** (`catalog/next.controller.ts`) scores videos for "after this one": same Space +3, shared tags up to
  +6, same topic +2, watched by the same people up to +4 (the prepared related list), your topics +1, then
  popularity and freshness; finished videos sink. At most 2 from one Space in any 4.
- **Trending** (`catalog/trending.ts`): videos of the last 30 days by views in the last two days; per country when
  it has enough local creators.

## Cost at scale

| Per "For you" request | Cost |
| --- | --- |
| Taste | one Redis read (rebuilt at most every 30 minutes: 4 small indexed queries) |
| Candidates | ~15 Redis reads, one indexed query (followed Spaces) |
| Features | one Redis pipeline for a few hundred videos |
| Ranking | in memory, about a millisecond for 600 candidates |
| Cards | one primary-key query for 24 videos |

The ranked list is kept per viewer for 10 minutes, so scrolling does not repeat any of this. The heavy work (quality,
pools, related lists) happens in the worker, once for everyone, and grows with the number of videos people watch,
not with the number of viewers.

## Tuning (next)

The weights above are set by hand. To tune them with evidence:

1. **Log impressions and outcomes.** "Shown" is already kept per viewer for two days (`rec:seen:*`). Add, per card
   shown: position, reason, and whether it was opened and how much was watched.
2. **Measure per reason and weight set** the share opened and the watch time per impression, and compare two
   weight sets on random halves of viewers (A/B), watching session length and "Not for me" rates.
3. **Learn the weights** (logistic regression on "watched more than 50%" over the features above) once there are
   enough impressions; keep the same features, guards and mix rules.
4. **Embeddings later.** At large scale, replace "related" counts with learned video and viewer vectors (two-tower
   model) served from a nearest-neighbour index. The candidate → score → arrange shape stays the same.
