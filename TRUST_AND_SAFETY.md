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
- With the **AI moderator** on (an Anthropic key in Administration → Secrets), it decides alone, with a reason the
  creator reads: **publish**, **limit** (by link only, out of feeds, search and recommendations) or **reject** (not
  shown). No person is needed, and every creator can appeal once.
- Without it, a video over a line is **held** for the moderators' queue, most serious first, and a person decides.
- Child sexual abuse material never goes to an AI: fingerprint matches and partner-scanner findings are held for a
  person (see below).

## The AI moderator (Claude)

Code: `apps/api/src/safety/ai.ts`. Turned on by saving an **Anthropic API key** in **Administration → Secrets**.
The key is checked, stored encrypted (AES-256-GCM), and never shown again, not even to administrators. The form
closes as soon as it is saved. Only the names of changed keys go into the audit log.

**Published at once, checked just after.** While a video uploads and is processed, the quick local checks run
(blocked files, the words of its title and description, other apps' marks in the file, Content ID). As soon as it
plays it is published, and the creator sees it published. Claude then looks at it straight away (a few seconds). If
it breaks the Community Guidelines it is hidden from everyone but its creator, who sees **"Not published"** and the
reason in Creator Hub and can ask for another look once. Followers are told about a new video only after Claude has
looked. If Claude cannot be reached, the video stays published.

To keep the cost down, Claude sees only a few small frames (2 to 4 for a short video, 6 for a long one, at most 512
px), and Haiku decides alone unless it would reject a video while unsure.

| Step | Model | When | Cost (about) |
| --- | --- | --- | --- |
| First look | Claude Haiku 5.5, low effort | Every video (frames plus title, description and tags), comment, edited title and transcript | Well under $0.001 a video; less for words |
| Careful look | Claude Opus 5.5, medium effort | Only before rejecting a video Haiku is unsure about (confidence under 0.75), or when Haiku declines to answer | A few cents |
| Appeal | Claude Opus 5.5, high effort | Once per video, when its creator asks (Creator Hub → "Ask for another look") | A few cents |

- **What it reads:** the Community Guidelines and Rwanda's law on genocide ideology and divisionism, in the system
  prompt (cached for an hour, so it is paid for once).
  - It also weighs what the built-in word rules and any picture classifier noticed.
  - Users' words are wrapped and marked as content to judge, never instructions to follow.
- **Decisions:**
  - **publish:** shown as usual.
  - **limit:** watchable by its link, but not recommended or found in search. After 3 days it is released, unless 2 or
    more people reported it; then it is hidden for a moderator.
  - **reject:** not published, or hidden if it was already published (transcripts, edits). The creator sees the
    reason in the Creator Hub and can appeal once. If the appeal is accepted, the video is published as the creator
    chose.
  - Each decision is kept as a resolved report, so moderators can look over the AI's work.
- **If both models decline to look,** the content is rejected (a refusal is a strong sign), and the creator can
  appeal.
- **If Anthropic cannot be reached,** the built-in rules and the unscanned-video rule apply, as without the AI.
- **Live chat** uses the built-in rules only, so it stays instant.
- **Comments at scale** (`engagement/comment-check.ts`): waiting for the AI on every comment would slow posting and cost
  the most of all checks, so comments are split by risk:
  - **High risk** (the word rules noticed something, or the account is under a week old): the AI decides before the
    comment is posted.
  - **Low risk:** the comment is shown at once and the AI checks it right after. If it breaks the rules, it is
    removed. The creator, or the person answered, is notified only after the check passes.
  - If the API stops before checking a comment, the worker checks it within a few minutes.
  - `SAFETY_AI_COMMENTS_PER_DAY` caps the AI's comment checks per day. Over the cap, low-risk comments get the word
    rules only.

## What is checked, and when

| What | When | If it is over the line |
| --- | --- | --- |
| The uploaded file's fingerprint (SHA-256, MD5) | Before anything else | Held (priority 100). Matches videos moderators removed and imported lists |
| Title, description, tags, and pictures with the AI moderator | While it is transcoded | AI: published, limited or rejected with a reason. Without it: held before it is ever shown |
| Pictures (frames across the video) | While it is transcoded, when an engine is configured | Held before it is ever shown |
| No picture engine configured | While it is transcoded | Published at once (the text rules and blocked files still apply). With `SAFETY_UNSCANNED_REVIEW=new`, the first videos of new Spaces (under a week old or under 3 published videos) wait for a person |
| Videos copied from other apps, platforms or TV | While it is transcoded | Not published, and the creator is told at once on the upload screen. Decided by the marks in the file, or by the AI moderator when it sees another service's logo |
| Copies of protected works (Content ID, RIGHTS.md) | While it is transcoded | The picture and sound are fingerprinted and matched against every published video and registered work. A copy is blocked (or, for verified rights holders who chose it, published with its ad money going to them). The uploader can dispute; the owner decides |
| Edits to title, description, tags | Before they are saved | The video is hidden at the same moment, and a moderator is asked |
| What is said (automatic transcript) | When captions are made, after publishing | AI: limited or hidden with a reason (appealable). Without it: hidden and a moderator is asked |
| Comments | Before they are posted; with the AI moderator, low-risk ones (established accounts, nothing the word rules notice) are shown at once and checked by the AI within seconds | Not posted, and the writer is told why; or removed just after it was shown. Edits are checked before they are saved |
| Direct messages | Before they are delivered | Not sent; the writer is told why. Either person can block the other (no messages either way). New conversations are limited to 20 a day per account, and messages to 60 an hour |
| Live chat | Before it reaches anyone | Not sent; the writer is told why (built-in rules only, so chat stays instant) |
| Reports from people | Any time | Several established accounts hide the video until a moderator decides (`REPORT_HOLD_THRESHOLD`) |

## Videos copied from other apps, platforms or TV

Free Me does not publish videos copied from elsewhere. They take someone else's work, and they carry another
service's logo and the original account's name. The creator is told at once, on the upload screen: "Unfortunately,
we are not going to publish this video", with the reason and how to fix it. They can ask for another look once.

- **Marks in the file** (`media/probe.ts`, `madeByApp`). These decide at once, with no AI and no person:
  - TikTok and Douyin write a `vid:` comment and other tags into every video saved from the app;
  - Kwai, Likee, Snapchat and Triller name themselves in a tag;
  - download tools write the page they took the video from: YouTube, Instagram, Facebook, X, Vimeo, Dailymotion,
    Twitch, Pinterest, Threads, Telegram, Snack Video, Bigo Live, Kick, Netflix or Showmax.
- **Logos in the pictures** (the AI moderator, category `reupload`): any well-known app's, platform's, streaming
  service's or TV channel's watermark, logo, @name tag, channel badge or end screen, in any corner and in the last
  frames. This catches screen recordings, which carry no marks in the file.
- **Allowed:** a logo that is part of the scene (a brand on clothing, a product, a shop sign, a stadium advert), or the
  creator's own name or logo.
- **Without the AI moderator,** a screen recording with no marks in its file is not caught automatically. People can
  report it.

## Graphic injuries and gore

Real blood, open or bleeding wounds, burns, severed or broken body parts, and dead or dying people or animals with
visible injuries are never published, in any context, news included. Fake film blood and make-up is allowed.
Upsetting news without visible injuries can be published.

- With the AI moderator, these are rejected (never "limited"), and the creator reads why.
- Without it, a picture classifier that is at least 90% sure of gore, or of explicit sexual content, rejects the
  video at once. Below that, a video over the line waits for a moderator.
- Possible child sexual abuse material is always held for a person, never decided by a machine.

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
| Re-uploaded from another app | 0.6 | 30 |

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
- Machines make mistakes both ways. With the AI moderator, creators can appeal every rejection or limit once, and
  moderators can review its decisions (kept as resolved reports). Without it, every hold is decided by a person.
- Moderators who speak Kinyarwanda, French, English and Swahili are needed from day one: they decide held videos
  and keep the term lists current.
