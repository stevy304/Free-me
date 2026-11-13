/**
 * What the automatic safety check looks for and what it does about it (see TRUST_AND_SAFETY.md).
 *
 * Every engine (built-in rules, an AI provider, an outside scanner) answers with a score from 0 to 1 per category.
 * The policy turns scores into one decision: let it through, or hold it for a person to decide. Nothing is removed
 * automatically; a person always decides. Videos are held before anyone else can see them; comments and chat
 * messages over the line are refused with the reason.
 */
export const CATEGORIES = ['sexual/minors', 'sexual', 'violence/graphic', 'violence', 'hate', 'harassment', 'self-harm', 'illicit', 'spam', 'reupload'] as const;
export type Category = typeof CATEGORIES[number];
export type Scores = Partial<Record<Category, number>>;

interface Rule { /** Hold a video (or refuse a comment) from this score */ hold: number; /** Queue order (see Report.priority) */ priority: number; label: string }
export const POLICY: Record<Category, Rule> = {
  // Any real sign is enough: a person must look, and fast. (Known images are matched by fingerprint, see screening.ts.)
  'sexual/minors': { hold: 0.2, priority: 100, label: 'Possible sexual content involving a minor' },
  'sexual': { hold: 0.6, priority: 80, label: 'Sexual content or nudity' },
  'violence/graphic': { hold: 0.6, priority: 80, label: 'Graphic violence or gore' },
  'hate': { hold: 0.6, priority: 60, label: 'Hate or incitement against a group' },
  'self-harm': { hold: 0.6, priority: 60, label: 'Suicide or self-harm' },
  'violence': { hold: 0.85, priority: 40, label: 'Violence or threats' },
  'harassment': { hold: 0.8, priority: 40, label: 'Harassment or bullying' },
  'illicit': { hold: 0.85, priority: 40, label: 'Weapons, drugs or other illegal goods' },
  'spam': { hold: 0.9, priority: 20, label: 'Spam or scam' },
  // Downloaded from another app (TikTok and others): its watermark or the app's marks in the file. Not published; the
  // creator can upload their original instead, or appeal.
  'reupload': { hold: 0.6, priority: 30, label: 'Re-uploaded from another app' },
};

export interface Decision { hold: boolean; category: Category | null; score: number; priority: number; reason: string | null; scores: Scores }

/** Combines several engines' scores (the highest per category counts) into one decision. */
export function decide(...all: Scores[]): Decision {
  const scores: Scores = {};
  for (const s of all) for (const [k, v] of Object.entries(s) as Array<[Category, number]>) if (POLICY[k] && Number.isFinite(v)) scores[k] = Math.max(scores[k] ?? 0, v);
  // The most serious category over its line decides (child safety first, then by queue priority).
  const over = (Object.entries(scores) as Array<[Category, number]>).filter(([k, v]) => v >= POLICY[k].hold)
    .sort((a, b) => POLICY[b[0]].priority - POLICY[a[0]].priority || b[1] - a[1]);
  if (!over.length) return { hold: false, category: null, score: 0, priority: 0, reason: null, scores };
  const [category, score] = over[0];
  return { hold: true, category, score, priority: POLICY[category].priority, reason: `${POLICY[category].label} (automatic check, ${Math.round(score * 100)}%)`, scores };
}
