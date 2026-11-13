# Trust and safety: how Free Me finds harmful content

Code: `apps/api/src/safety/` (rules, engines, policy, checks), `apps/api/src/media/screening.ts` (fingerprints),
`apps/api/src/trust/` (reports, moderation queue, the moderators' term lists).

## The rule

**Nothing anyone uploads can be seen by anyone else before it has been checked.**

- A new video (an upload or a live recording) starts *unchecked* (`Video.safetyCheckedAt` empty). Until the check
  passes:
  - it is in no list, feed, search or recommendation;
  - its watch page answers "not available" to everyone but its owner;
  - its files stay behind signed links, never on the public CDN, even if the creator already set it to Public.
- The check runs **while the video is transcoded**, so a clean video is not delayed. The first playable version is
  only published once the answer is in.
- A video that does not pass is **held**: it is not published, and it goes into the moderators' queue, most serious
  first. A person always makes the final decision: nothing is deleted automatically, and the creator can ask for a
  review.

## What is checked, and when

| What | When | If it is over the line |
| --- | --- | --- |
| The uploaded file's fingerprint (SHA-256, MD5) | Before anything else | Held (priority 100). Matches videos moderators removed and imported lists |
| Title, description, tags | While it is transcoded | Held before it is ever shown |
| Pictures (frames across the video) | While it is transcoded, when an engine is configured | Held before it is ever shown |
| No picture engine configured | While it is transcoded | First videos of new Spaces (under a week old or under 3 published videos) wait for a person (`SAFETY_UNSCANNED_REVIEW`) |
| Edits to title, description, tags | Before they are saved | The video is hidden at the same moment, and a moderator is asked |
| What is said (automatic transcript) | When captions are made, after publishing | The video is hidden and a moderator is asked |
| Comments | Before they are posted | Not posted; the writer is told why |
| Live chat | Before it reaches anyone | Not sent; the writer is told why (built-in rules only, so chat stays instant) |
| Reports from people | Any time | Several established accounts hide the video until a moderator decides (`REPORT_HOLD_THRESHOLD`) |

## Categories and lines

Every engine scores each category from 0 to 1; the highest score per category counts. A category over its line
holds the video (or refuses the comment). The queue puts the most serious first.

| Category | Holds from | Queue priority |
| --- | ---: | ---: |
| Sexual content involving a minor | 0.2 | 100 |
| Sexual content or nudity | 0.6 | 80 |
| Graphic violence or gore | 0.6 | 80 |
| Hate or incitement against a group | 0.6 | 60 |
| Suicide or self-harm | 0.6 | 60 |
| Violence or threats | 0.85 | 40 |
| Harassment or bullying | 0.8 | 40 |
| Weapons, drugs, other illegal goods | 0.85 | 40 |
| Spam or scam | 0.9 | 20 |

## Engines

**Built-in rules (always on, no outside service).** They cover titles, descriptions, tags, comments, chat and
transcripts.

- **Normalising:** text is normalised first, so disguises do not get through: accents, s3x, kiiill, s e x, p.o.r.n.
- **Terms:** words and phrases per category, each with a weight. Weight 1 is enough on its own. Weight 0.6 counts
  only together with another finding, for words that can be literal (in Kinyarwanda, *inyenzi* is also just
  "cockroach").
- **Threats against a group:** a word for a people, religion or group in the same sentence as a word for killing,
  wiping out or expelling. This catches incitement without slurs, in English, French and Kinyarwanda ("tubamare
  abatutsi", "les X doivent mourir", "kill all the X"). It matters most in Rwanda, where genocide ideology and
  divisionism are crimes.
- **Moderators' terms:** moderators add the slang, coded words and local slurs no list written in advance knows, in
  Administration → Safety (`/api/moderation/safety`). A field there shows what the check would do with any wording.
  Native speakers of every language the platform serves should own their language's list.

**An engine that looks at pictures** (`SAFETY_ENGINE`):

| Engine | Covers | Data | Cost |
| --- | --- | --- | --- |
| `openai` (`SAFETY_OPENAI_KEY`) | Images and text, many languages (weak in Kinyarwanda) | Frames and text are sent to OpenAI | Free with an OpenAI account |
| `http` (`SAFETY_SCAN_URL`) | Whatever service you run or buy (Hive, Sightengine, an open model on your own GPU) | Your choice | Your choice |
| `none` | Text only (built-in rules); new Spaces' videos wait for a person | Nothing leaves your servers | Free |

The `http` service receives `{ videoId, sha256, md5, durationSeconds, text, frames: [base64 JPEG] }`. It answers
`{ scores: { category: 0..1 } }`, or `{ match: true, label }` for fingerprint scanners.

If the engine cannot be reached, the video is treated as unscanned. With `SAFETY_SCAN_FAIL_CLOSED=true` it is held
instead.

## Child sexual abuse material: what the law and partners require

No platform builds its own detector for this, and Free Me must not try. What is needed before launch:

1. **Hash matching with an official partner:**
   - NCMEC (US, free for platforms);
   - the Internet Watch Foundation (UK, membership);
   - Thorn Safer;
   - or Microsoft PhotoDNA (free for qualifying services).

   Their lists go in through `tools/import-hashes`, and the scanner (`SAFETY_SCAN_URL`) does the perceptual
   matching. Any match is held with priority 100.
2. **Reporting:** report confirmed material to NCMEC's CyberTipline and to Rwanda's authorities (RIB). Preserve it
   as the law requires. Never re-share it, not even with colleagues.
3. **Moderator welfare:** blurred previews by default, limits on exposure, and counselling. This is ongoing work, not
   a one-time setup.

## What people should know

- The Community Guidelines (`/legal/guidelines`) say what is not allowed. The automatic check enforces them; it does
  not add new rules.
- Machines make mistakes both ways. Every hold is decided by a person, and every creator can ask for a review.
- Moderators who speak Kinyarwanda, French, English and Swahili are needed from day one: they decide held videos
  and keep the term lists current.
