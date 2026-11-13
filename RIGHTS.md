# Rights: Content ID for Free Me

Code: `apps/api/src/media/content-id.ts` (fingerprints and matching), `apps/api/src/rights/` (claims, the Rights
pages' API), Creator Hub → Rights, Administration → Rights.

## What every upload goes through

1. **Exact file fingerprints** (SHA-256 and MD5, `media/screening.ts`). They catch byte-for-byte copies of removed
   videos and of imported hash lists.
2. **Marks of other apps** in the file (TikTok's `vid:` tag and others, `media/probe.ts`).
3. **Content ID**, while the video is processed, after the safety check:
   - **Picture:** one 64-bit difference hash per second, from a 9×8 grey thumbnail. It survives re-encoding,
     resizing and lower quality.
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
   - **sound:** a second matches when under 35% of its bits differ.
4. **A match needs** at least 10 matching seconds, or half of a short upload (at least 5 s).
5. **Still pictures** (a slide, a plain talking head) are not matched by picture alone: the matched stretch must keep
   changing. They are matched by their sound.

Tests (`test/content-id.test.ts`, with real FFmpeg edits) cover:
- copies made smaller and lower quality;
- copies with the start cut off (found at the right place);
- the same soundtrack under another picture (matched by sound);
- unrelated videos and still pictures (not matched).

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
