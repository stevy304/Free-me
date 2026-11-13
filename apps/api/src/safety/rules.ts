import type { PrismaClient } from '@prisma/client';
import type { Category, Scores } from './policy';

/**
 * The built-in text check: no outside service, works from the first day, for titles, descriptions, tags, comments,
 * live chat and speech transcripts. Two kinds of rules:
 *
 * 1. Terms (words and phrases) per category and language, with a weight (1: enough alone; 0.6: only together with
 *    another finding). Built-in lists below hold the clear cases; moderators add the rest (slang, coded words, local
 *    slurs) in Administration → Safety, per language, because no list written in advance knows them.
 * 2. Threats against a group: a word for a people, a religion or a group close to a word for killing, wiping out or
 *    expelling, in the same sentence ("all X must die", "tubamare abatutsi"). This is how incitement is caught even
 *    without slurs, which matters most where genocide ideology is a crime (Rwanda).
 *
 * Text is normalised first, so common disguises do not get through: accents, letter-for-number swaps (s3x, 4ll),
 * repeated letters (kiiiill), and letters spaced out (s e x, k.i.l.l).
 */
export interface Term { term: string; category: Category; weight: number }

const T = (category: Category, weight: number, terms: string[]): Term[] => terms.map((term) => ({ term, category, weight }));

/** Clear cases only; everything else is for moderators to add (see above). */
export const BUILT_IN: Term[] = [
  // Child sexual abuse material: terms its traders use. Any match is held for a person at once.
  ...T('sexual/minors', 1, ['child porn', 'cp video', 'pthc', 'preteen sex', 'jailbait', 'lolicon', 'underage sex', 'pedo video', 'abana bambaye ubusa', 'pornographie infantile', 'pedopornographie']),
  ...T('sexual', 1, ['porn', 'porno', 'pornhub', 'xxx video', 'sex tape', 'sextape', 'nude video', 'nudes', 'onlyfans', 'blowjob', 'hardcore sex', 'video porno', 'film porno', 'baise', 'filme za porono']),
  ...T('sexual', 0.6, ['sexy', 'naked', 'nue', 'bambaye ubusa', 'ubusa', 'sex']),
  ...T('violence/graphic', 1, ['beheading', 'decapitation', 'gore video', 'dismembered', 'execution video', 'decapitation video', 'video de decapitation']),
  ...T('violence/graphic', 0.6, ['gore', 'corpse', 'dead bodies', 'imirambo', 'cadavres']),
  ...T('self-harm', 1, ['how to kill myself', 'suicide method', 'ways to die', 'comment se suicider']),
  ...T('self-harm', 0.6, ['kill myself', 'want to die', 'suicide', 'kwiyahura', 'me suicider']),
  ...T('illicit', 0.6, ['buy cocaine', 'buy weed', 'cocaine for sale', 'guns for sale', 'fake passport', 'fake id', 'counterfeit money']),
  ...T('spam', 0.6, ['free money', 'earn money fast', 'crypto giveaway', 'double your bitcoin', 'click the link in my bio', 'subscribe to my channel', 'follow for follow', 'sub4sub']),
  // Rwanda: words of the 1994 genocide propaganda. On their own they can be literal ("cockroach", "snake"), so they
  // count fully only together with another finding, such as a group named next to them.
  ...T('hate', 0.6, ['inyenzi', 'inzoka', 'ibyitso', 'hutu power', 'cockroaches', 'cafards']),
  ...T('hate', 1, ['gutsemba abatutsi', 'gutsemba abahutu', 'tubatsembe', 'hutu power forever', 'genocide was justified', 'jenoside ntiyabaye']),
];

/** Words for peoples, religions and other groups (lower case, normalised). */
const GROUPS = ['abatutsi', 'abahutu', 'abatwa', 'tutsi', 'tutsis', 'hutu', 'hutus', 'twa', 'jews', 'juifs', 'muslims', 'musulmans', 'abayisilamu', 'christians', 'chretiens', 'abakirisitu',
  'gays', 'homosexuels', 'abatinganyi', 'blacks', 'noirs', 'whites', 'blancs', 'arabs', 'arabes', 'immigrants', 'refugees', 'refugies', 'impunzi', 'women', 'femmes', 'abagore', 'congolese', 'congolais', 'abanyekongo', 'burundians', 'abarundi', 'ugandans'];
/** Killing, wiping out, expelling. */
const HARM = ['kill', 'killed', 'die', 'exterminate', 'exterminated', 'wipe out', 'wiped out', 'eliminate', 'slaughter', 'burn', 'hang', 'expel', 'deport', 'should not exist',
  'tuer', 'mourir', 'exterminer', 'eliminer', 'massacrer', 'bruler', 'chasser', 'kwica', 'bicwe', 'mubice', 'tubice', 'kubica', 'gutsemba', 'tubatsembe', 'kubamara', 'tubamare', 'kubirukana', 'nibapfe', 'bapfe'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Lower case, no accents, digits-for-letters undone, long repeats shortened, spaced-out letters joined. */
export function normalise(text: string): string {
  let s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[013457@$!]/g, (c, i, all) => (/[a-z]/.test(all[i - 1] ?? '') || /[a-z]/.test(all[i + 1] ?? '') ? LEET[c] : c));
  s = s.replace(/([a-z])\1{2,}/g, '$1');
  // "s e x", "k.i.l.l", "p-o-r-n": three or more single letters separated by one space or mark become one word.
  s = s.replace(/\b(?:[a-z][\s._\-*]){2,}[a-z]\b/g, (m) => m.replace(/[\s._\-*]/g, ''));
  return s.replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

const has = (hay: string, term: string) => {
  const t = normalise(term);
  return t.length > 0 && ` ${hay} `.includes(` ${t} `);
};

/** Scores per category for a text (0 when nothing matched). `extra`: terms moderators added. */
export function scoreText(text: string, extra: Term[] = []): { scores: Scores; matches: Array<{ term: string; category: Category }> } {
  const scores: Scores = {};
  const matches: Array<{ term: string; category: Category }> = [];
  if (!text.trim()) return { scores, matches };
  const s = normalise(text);
  const weak: Partial<Record<Category, number>> = {};
  for (const t of [...BUILT_IN, ...extra]) {
    if (!has(s, t.term)) continue;
    matches.push({ term: t.term, category: t.category });
    if (t.weight >= 1) scores[t.category] = 1;
    else weak[t.category] = (weak[t.category] ?? 0) + 1;
  }
  // Threats against a group, sentence by sentence.
  for (const sentence of normalise(text.replace(/[.!?\n]+/g, ' | ')).split('|')) {
    const words = ` ${sentence.trim()} `;
    const group = GROUPS.find((g) => words.includes(` ${g} `));
    const harm = HARM.find((h) => words.includes(` ${h} `));
    if (group && harm) { scores.hate = 1; matches.push({ term: `${group} … ${harm}`, category: 'hate' }); }
  }
  // Weak terms: one alone is a hint (0.5, under every line), two different ones, or one next to a strong finding, count.
  const strong = Object.keys(scores).length > 0;
  for (const [k, n] of Object.entries(weak) as Array<[Category, number]>) scores[k] = Math.max(scores[k] ?? 0, n >= 2 || strong ? 0.7 : 0.5);
  // A "hate" hint next to a named group (without a harm word) is still worth a look.
  if (weak.hate && GROUPS.some((g) => ` ${s} `.includes(` ${g} `))) scores.hate = Math.max(scores.hate ?? 0, 0.7);
  return { scores, matches };
}

let cache: { at: number; terms: Term[] } | null = null;
/** Terms moderators added (kept a minute in each process). */
export async function moderatorTerms(prisma: Pick<PrismaClient, 'safetyTerm'>): Promise<Term[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.terms;
  const rows = await prisma.safetyTerm.findMany({ select: { term: true, category: true, weight: true } });
  cache = { at: Date.now(), terms: rows.map((r) => ({ term: r.term, category: r.category as Category, weight: r.weight })) };
  return cache.terms;
}
export const forgetModeratorTerms = () => { cache = null; };
