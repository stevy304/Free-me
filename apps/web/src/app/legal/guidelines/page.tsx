import type { Metadata } from 'next';
import Link from 'next/link';
import { REPORT_REASONS } from '@free-me/shared';
import { LegalPage } from '../LegalPage';
import { LAST_UPDATED } from '../site';

export const metadata: Metadata = { title: 'Community Guidelines' };

const DETAIL: Record<string, string[]> = {
  SEXUAL_CONTENT: ['Pornography and sexually explicit content.', 'Nudity for sexual gratification. Educational, documentary, scientific or artistic nudity can stay if the context is clear.'],
  CHILD_SAFETY: ['Any content that sexualises minors. We remove it, close the account and report it to the authorities.', 'Content that endangers children, encourages them to do dangerous things, or targets them with harmful material.'],
  VIOLENT_OR_GRAPHIC: ['Real violence or gore shown to shock or glorify.', 'Praise or support for violent attacks or the groups behind them. News and documentary context is allowed when it is clear and not gratuitous.'],
  HATE_OR_HARASSMENT: ['Attacks on people for their ethnicity, nationality, religion, disability, sex, gender, sexual orientation, age or similar attributes.', 'Threats, bullying, insults aimed at a person, or encouraging others to harass someone.'],
  DANGEROUS_ACTS: ['Encouraging suicide, self-harm or eating disorders. Content that helps people seek support is welcome.', 'Dangerous challenges and instructions to make weapons or harm others.'],
  MISINFORMATION: ['False claims that can cause real-world harm, such as dangerous medical advice or lies about how to vote.'],
  SPAM_OR_SCAM: ['Scams, phishing and fake giveaways.', 'Misleading titles or thumbnails, repetitive or mass-produced content, and artificially inflating views, likes, follows or comments.'],
  PRIVACY: ['Sharing someone\'s private information (address, phone number, documents) or intimate images without their consent.'],
  IMPERSONATION: ['Pretending to be another person, channel or organisation in a way that misleads people.'],
  OTHER: ['Illegal goods and services, and anything else that breaks the law where it is published.'],
};

export default function Guidelines() {
  return (
    <LegalPage
      path="/legal/guidelines" title="Community Guidelines" updated={LAST_UPDATED}
      intro={<>
        <p>Free Me is for everyone, everywhere. These rules keep it a place where creators can share freely and viewers feel safe. They apply to videos, Moments, thumbnails, titles, descriptions, comments and collections.</p>
        <p>Context matters: education, news, documentary, art and satire can show difficult subjects when the purpose is clear. If you are unsure, add context in the title and description.</p>
      </>}
      sections={[
        ...REPORT_REASONS.map((r) => ({ id: r.code.toLowerCase(), title: r.label, body: <ul>{(DETAIL[r.code] ?? [r.hint]).map((t) => <li key={t}>{t}</li>)}</ul> })),
        { id: 'copyright', title: 'Copyright', body: <p>Post only what you made or have permission to use. Rights holders can send a copyright notice; see the <Link href="/legal/copyright">Copyright policy</Link>.</p> },
        { id: 'kids', title: 'Videos made for kids', body: <p>If your video is made for children, mark it as made for kids when you publish it. Comments are always off on those videos. Marking content wrongly to reach children is a violation.</p> },
        { id: 'enforcement', title: 'What happens when rules are broken', body: <>
          <ul>
            <li>Anyone can report a video with <strong>Report</strong> under it. Reports are confidential.</li>
            <li>A moderator reviews the report. Removed videos disappear everywhere; the creator is emailed the reason.</li>
            <li>Each removal is a strike on the channel for 90 days. Channels with repeated strikes, or a single severe violation (such as child safety), can be suspended or closed.</li>
            <li>Creators can ask for a review by replying to the removal email. If a video was removed by mistake, it is restored and the strike is lifted.</li>
            <li>Creators can remove comments on their own videos and pin one comment.</li>
          </ul>
        </>},
      ]}
    />
  );
}
