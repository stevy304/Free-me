/**
 * Content ID accuracy measurement (RIGHTS.md, "How accurate is it").
 *
 *   node dist/tools/content-id-eval.js [folder of videos]      (or: npx tsx src/tools/content-id-eval.ts [folder] [--verbose])
 *
 * Every video in the folder is an original. For each, FFmpeg makes the edits re-uploaders use. The originals are
 * stored as references, every edited copy is checked, and the tool reports:
 * - recall per edit: how many copies were found as their own original;
 * - wrong matches: copies matched to a different original (false positives);
 * - same song, other picture: by sound only (counts for verified rights holders' works, not ordinary creators').
 *
 * Without a folder, a varied synthetic set is generated (moving pictures and changing tones). Real footage gives the
 * numbers that matter: run it on 50 to 200 videos you have the rights to. It uses the configured database
 * (DATABASE_URL) and removes everything it created when done.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { fingerprintFile, findMatches, minimumMatch, saveFingerprint } from '../media/content-id';
import { probe } from '../media/probe';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const ff = (args: string[]) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

/** The edits checked, each made from an original. */
const EDITS: Array<{ name: string; args: (src: string, other: string) => string[] }> = [
  { name: 'smaller, lower quality', args: (s) => ['-i', s, '-vf', 'scale=-2:360', '-crf', '36', ...enc, '-b:a', '64k'] },
  { name: 'start cut (3.7 s)', args: (s) => ['-ss', '3.7', '-i', s, ...enc] },
  { name: 'black bars', args: (s) => ['-i', s, '-vf', 'scale=iw*3/4:ih*3/4,pad=iw*4/3:ih*4/3:(ow-iw)/2:(oh-ih)/2:black,scale=trunc(iw/2)*2:trunc(ih/2)*2', ...enc] },
  { name: 'vertical crop', args: (s) => ['-i', s, '-vf', 'crop=ih*9/16:ih,scale=720:1280', ...enc] },
  { name: 'mirrored', args: (s) => ['-i', s, '-vf', 'hflip', ...enc] },
  { name: '1.25x faster', args: (s) => ['-i', s, '-vf', 'setpts=PTS/1.25', '-af', 'atempo=1.25', ...enc] },
  { name: '0.9x slower', args: (s) => ['-i', s, '-vf', 'setpts=PTS/0.9', '-af', 'atempo=0.9', ...enc] },
];

/** A varied synthetic set when no folder is given: different moving pictures, different changing tones. */
function synthetic(dir: string, n = 12): string[] {
  // Each one a different picture (its own random seed or place), so a match between two of them is wrong.
  const pic = (i: number) => [
    `life=size=960x540:rate=25:mold=10:ratio=0.3:seed=${100 + i}`,
    `cellauto=size=960x540:rate=25:rule=${[30, 90, 110, 150, 182, 225][(i >> 1) % 6]}:random_seed=${200 + i}:scroll=1`,
    `mandelbrot=size=960x540:rate=25:start_x=${-0.75 + i * 0.011}:start_y=${0.1 + i * 0.007}:end_scale=0.005`,
  ][i % 3];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = join(dir, `synthetic-${i}.mp4`);
    const tune = `sin(2*PI*t*(${220 + i * 37}+${90 + i * 13}*sin(2*PI*t/${2 + (i % 5)})+${40 + i * 7}*sin(2*PI*t/${5 + (i % 3)})))*0.6`;
    ff(['-f', 'lavfi', '-i', pic(i), '-f', 'lavfi', '-i', `aevalsrc=${tune}:s=44100`, '-t', '30', ...enc, f]);
    out.push(f);
  }
  return out;
}

async function main() {
  const verbose = process.argv.includes('--verbose');
  const folder = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const work = mkdtempSync(join(tmpdir(), 'content-id-eval-'));
  const prisma = new PrismaClient();
  const created: string[] = [];
  try {
    const originals = folder ? readdirSync(folder).filter((f) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(extname(f))).map((f) => join(folder, f)) : synthetic(work, Number(process.env.EVAL_COUNT ?? 12));
    if (originals.length < 2) throw new Error('Give a folder with at least 2 videos.');
    console.log(`Content ID evaluation: ${originals.length} ${folder ? 'videos from ' + folder : 'synthetic videos'}\n`);
    // Store the originals as references.
    const u = await prisma.user.create({ data: { email: `content-id-eval-${Date.now()}@example.invalid` } });
    const ch = await prisma.channel.create({ data: { userId: u.id, handle: `cideval${Date.now()}`, name: 'Content ID evaluation' } });
    const ids: string[] = [];
    for (const f of originals) {
      const info = await probe(FFPROBE, f);
      const v = await prisma.video.create({ data: { channelId: ch.id, title: f, durationSeconds: Math.round(info.durationSeconds) } });
      created.push(v.id); ids.push(v.id);
      await saveFingerprint(prisma, v.id, await fingerprintFile(FFMPEG, f, info));
    }
    const rows: Array<[string, number, number, number]> = [];
    const check = async (file: string) => { const info = await probe(FFPROBE, file); return findMatches(prisma, await fingerprintFile(FFMPEG, file, info, undefined, true), minimumMatch(Math.round(info.durationSeconds))); };
    for (const e of EDITS) {
      let found = 0; let wrong = 0;
      for (const [i, f] of originals.entries()) {
        const copy = join(work, `copy-${i}.mp4`);
        try { ff([...e.args(f, originals[(i + 1) % originals.length]), copy]); } catch { continue; }
        const m = await check(copy);
        if (m.some((x) => x.videoId === ids[i])) found++;
        for (const x of m.filter((y) => y.videoId !== ids[i])) { wrong++; if (verbose) console.log(`  wrong: ${e.name} copy of #${i} matched #${ids.indexOf(x.videoId)}: picture ${x.picture?.seconds ?? 0} s, sound ${x.sound?.seconds ?? 0} s ${x.edits?.join(', ') ?? ''}`); }
        if (verbose && !m.some((x) => x.videoId === ids[i])) console.log(`  missed: ${e.name} copy of #${i}`);
      }
      rows.push([e.name, found, originals.length, wrong]);
    }
    // Same song, another picture: the next original's picture with this one's sound.
    let bySound = 0; let wrongSong = 0;
    for (const [i, f] of originals.entries()) {
      const other = originals[(i + 1) % originals.length];
      const mix = join(work, `mix-${i}.mp4`);
      try { ff(['-i', other, '-i', f, '-map', '0:v', '-map', '1:a', '-shortest', ...enc, mix]); } catch { continue; }
      const m = await check(mix);
      if (m.some((x) => x.videoId === ids[i] && x.sound)) bySound++;
      if (verbose) for (const x of m) console.log(`  same sound #${i} under #${(i + 1) % originals.length}'s picture matched #${ids.indexOf(x.videoId)}: picture ${x.picture?.seconds ?? 0} s, sound ${x.sound?.seconds ?? 0} s`);
      wrongSong += m.filter((x) => x.videoId !== ids[i] && x.videoId !== ids[(i + 1) % originals.length]).length;
    }
    console.log('| Edit | Found | Recall | Wrong matches |\n| --- | ---: | ---: | ---: |');
    for (const [name, found, total, wrong] of rows) console.log(`| ${name} | ${found}/${total} | ${Math.round((100 * found) / total)}% | ${wrong} |`);
    console.log(`| same sound, other picture (by sound) | ${bySound}/${originals.length} | ${Math.round((100 * bySound) / originals.length)}% | ${wrongSong} |`);
    const totalWrong = rows.reduce((a, r) => a + r[3], 0) + wrongSong;
    const checks = rows.reduce((a, r) => a + r[2], 0) + originals.length;
    console.log(`\nWrong matches: ${totalWrong} in ${checks} checked copies (each copy could have matched ${originals.length - 1} other originals).`);
  } finally {
    if (created.length) await prisma.video.deleteMany({ where: { id: { in: created } } });
    await prisma.channel.deleteMany({ where: { handle: { startsWith: 'cideval' } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'content-id-eval-' } } });
    await prisma.$disconnect();
    rmSync(work, { recursive: true, force: true });
  }
}

void main().catch((e) => { console.error(e); process.exit(1); });
