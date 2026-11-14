# Rights: Content ID for Free Me

Code: `apps/api/src/media/content-id.ts` (fingerprints and matching), `apps/api/src/rights/` (claims, the Rights
pages' API), Creator Hub → Rights, Administration → Rights.

## What every upload goes through

1. **Exact file fingerprints** (SHA-256 and MD5, `media/screening.ts`). They catch byte-for-byte copies of removed
   videos and of imported hash lists.
2. **Marks of other apps** in the file (TikTok's `vid:` tag and others, `media/probe.ts`).
3. **Content ID**, while the video is processed, after the safety check:
   - **Picture:** one 64-bit difference hash per second, from a 9×8 grey thumbnail (sampled 4 times a second, so
     every frame rate is sampled at the same instants). Black bars are cut off first (FFmpeg `cropdetect`). It
     survives re-encoding, resizing and lower quality. The center 9:16 part is fingerprinted too, so a vertical
     crop of a wide video is found.
   - **Sound:** Chromaprint (the AcoustID algorithm, built into FFmpeg; Ubuntu's package has it). It recognises a song
     or a recorded broadcast even under another picture.
   - The first hour of a video is fingerprinted.

## How matching works

1. **Search keys.** Short keys from both fingerprints go into a search index (`FingerprintKey`):
   - picture: the brightness layout of three seconds in a row;
   - sound: the top 24 bits of every second Chromaprint value.
2. **Shortlist.** A new upload looks up its keys and votes for (video, time offset) pairs that line up. Keys found
   in more than 50 videos (a common logo, silence) are ignored.
3. **Second-by-second check.** The best candidates are compared second by second at that offset:
   - **picture:** a second matches when its hashes differ in at most 10 of 64 bits, or are clearly closer than the
     seconds just before and after (fast-moving video sampled at a slightly different instant);
   - **sound:** a second matches when at most 12% of its bits differ (a re-encoded copy stays under 5%), or 30% at
     the place the picture already matched (a sped-up copy).
4. **A match needs** at least 10 matching seconds, or half of a short upload (at least 5 s).
5. **Still pictures** (a slide, a plain talking head) are not matched by picture alone: the matched stretch must keep
   changing. They are matched by their sound.
6. **Edited copies.** A new upload is also checked:
   - **mirrored** (flipped left to right);
   - **faster or slower** (1.1x, 1.25x, 0.9x, 0.8x), for uploads up to 3 minutes. The sound is checked at the place
     the picture matched, since a sped-up song is changed too much for its keys to line up on their own.

   The claim says which edit was found ("mirrored", "at 1.25x speed", "reframed").
7. **Sound alone counts only for verified rights holders' works.** Two creators dancing to the same trending song, or
   filming the same anthem in a stadium, have the same sound and are not copies of each other. Ordinary creators'
   videos are protected by their picture; a label's song or a TV channel's broadcast is protected by its sound too.

Tests (`test/content-id.test.ts`, with real FFmpeg edits) cover:
- copies made smaller and lower quality;
- copies with the start cut off (found at the right place);
- black bars, a vertical crop, a mirror, 1.25x faster and 0.9x slower;
- the same soundtrack under another picture (matched by sound; claimed only for a verified holder's work,
  `test/rights.test.ts`);
- unrelated videos and still pictures (not matched).

## How accurate is it

Measure it with `apps/api/src/tools/content-id-eval.ts` (`npx tsx src/tools/content-id-eval.ts <folder>` in
`apps/api`). Every video in the folder is an original; the tool makes each edit above with FFmpeg, checks every copy
and reports recall per edit and wrong matches. Without a folder it uses a generated set (fractals, cellular automata,
test patterns with changing tones), which says the code works, not how it does on real footage. Run it on 50 to 200
real videos you have the rights to (music videos, football, talk shows, dance clips) before trusting the numbers.

Last run (13 Nov 2026, the generated set: 12 different 30-second videos, 96 checked copies):

| Edit | Found | Wrong matches by picture | Wrong matches by sound |
| --- | ---: | ---: | ---: |
| smaller, lower quality | 12/12 | 0 | 3 |
| start cut (3.7 s) | 12/12 | 0 | 4 |
| black bars | 12/12 | 0 | 6 |
| vertical crop | 12/12 | 0 | 6 |
| mirrored | 12/12 | 0 | 6 |
| 1.25x faster | 10/12 | 0 | 0 |
| 0.9x slower | 12/12 | 0 | 0 |
| same sound, other picture (found by sound) | 12/12 | 0 | 6 |

What it says:
- **Picture matching made no wrong match** in 96 copies, and found every copy except 2 sped-up ones.
- **The sound wrong matches are between the generated tones** that follow the same pitch pattern (videos 0, 5 and 10):
  Chromaprint hears pitch classes, and three plain tones in the same pattern sound alike to it for 10 to 16 seconds.
  Real songs are far richer, but this is why sound alone counts only for verified rights holders' works, and why the
  sound threshold must be checked on real music before it is relaxed.
- **Not yet measured:** real footage and real songs, a song re-recorded through a phone speaker (likely missed by
  sound at the 12% threshold), heavy compression from messaging apps.

**Not handled yet:**
- heavy zoom or crop (more than the bars and the 9:16 center), a picture inside a picture, overlays covering most of
  the frame;
- pitch-shifted songs, and speed changes on uploads over 3 minutes;
- anything after the first hour.

## What a match does

- **Every published video is protected** from other accounts automatically: a copy is **blocked**.
  - It is not published, and the uploader reads which work it matched, how many seconds, and of what (picture,
    sound).
  - A creator can turn protection off for a work (Creator Hub → Rights).
- **Which work is the original:** only works older than the upload count, and never the uploader's own Space.
- **Verified rights holders** (labels, studios, TV channels; an administrator verifies them in Administration →
  Rights) choose per work:
  - **block**;
  - **earn**: the copy is published with ads, even if its uploader does not earn, and the ad money goes to the rights
    holder;
  - **track**: the copy is published, and the owner sees it.

  They can also register **private** videos as reference works (songs, films) without publishing them.
- **Disputes:**
  1. The uploader disputes once, with a reason ("I filmed it", "I have permission").
  2. The owner **releases** the claim, which publishes a blocked video, or **keeps** it.
  3. Administrators can release any claim.

## At scale

- **Index size:** about 1.5 keys per second of video; an hour of video is about 5,400 rows.
- **PostgreSQL is enough for millions of hours**, because lookups are by exact key.
- **Beyond that,** the same keys move to a dedicated index (for example a key-value store or a vector index), with no
  change to the fingerprints.
- **Older videos:** a worker job fingerprints videos published before Content ID existed, most watched first, while
  their original file is kept. It never claims or blocks a video that is already published.
