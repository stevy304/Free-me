import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalPage } from '../LegalPage';
import { LAST_UPDATED, siteInfo } from '../site';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default async function Privacy() {
  const s = await siteInfo();
  const op = s.operatorName;
  return (
    <LegalPage
      path="/legal/privacy" title="Privacy Policy" updated={LAST_UPDATED}
      intro={<>
        <p>This policy explains what personal data Free Me collects, why, how long we keep it and the choices you have. {op} is responsible for your data (the &ldquo;controller&rdquo;). It is written to meet the EU and UK General Data Protection Regulation, Rwanda&apos;s Law N&deg; 058/2021 on the protection of personal data and privacy, and similar laws in other countries.</p>
        <p>We do not sell your personal data and Free Me has no third-party advertising or tracking scripts.</p>
      </>}
      sections={[
        { id: 'collect', title: 'What we collect', body: <>
          <ul>
            <li><strong>Account:</strong> your email address. If you sign in with Google, also your Google account identifier, name and profile picture, which Google shares with your permission.</li>
            <li><strong>Profile and channel:</strong> what you choose to add: display name, picture, bio, country, city, language, time zone, channel name, handle and description.</li>
            <li><strong>Your content:</strong> videos you upload (with their technical details, such as size, duration and resolution), thumbnails, titles, descriptions, tags, comments, collections, likes and dislikes.</li>
            <li><strong>Activity:</strong> the videos you watch while signed in and how far you got (your history, which lets you resume), and the channels you follow.</li>
            <li><strong>Reports:</strong> reports you send. Copyright notices and counter-notices also contain the name, email and postal address the law asks for.</li>
            <li><strong>Security data:</strong> for each signed-in session, the IP address, browser description and times of use; a log of security-relevant actions (sign-ins, changes to channels and videos, moderation decisions) with the IP address and browser.</li>
            <li><strong>View counting:</strong> to count each viewer once every 6 hours, we keep a one-way fingerprint of the IP address and browser of visitors who are not signed in, for 6 hours, in memory.</li>
          </ul>
        </>},
        { id: 'why', title: 'Why we use it, and on what legal basis', body: <>
          <ul>
            <li>To provide Free Me: your account, publishing and streaming your videos, comments, history, collections and follows (performance of our contract with you).</li>
            <li>To keep Free Me safe: preventing abuse, fraud and attacks, rate limits, moderating reports (our legitimate interest in a safe service, and legal obligations).</li>
            <li>To handle copyright notices and counter-notices, which includes forwarding the details the law requires to the other party (legal obligation).</li>
            <li>To send you service emails: sign-in codes, decisions about your videos and reports (contract and legal obligation). We do not send marketing emails.</li>
          </ul>
        </>},
        { id: 'shared', title: 'What other people can see', body: <>
          <p>Your channel, public videos, comments (with your channel name or display name and picture) and public collections are visible to everyone. Unlisted videos and collections are visible to anyone with the link. Private videos, private collections, your history, your likes and dislikes, and your reports are visible only to you (and to moderators where a report requires it). A creator sees how many dislikes their own videos have, never who disliked them.</p>
        </>},
        { id: 'processors', title: 'Service providers', body: <>
          <p>We use providers who process data only on our instructions: our hosting and object storage providers (which store videos and our databases), our email delivery provider, and Google for &ldquo;Sign in with Google&rdquo;. Some of them may be outside your country. When data leaves the European Economic Area, the UK or Rwanda, we rely on the safeguards those laws require, such as adequacy decisions or standard contractual clauses.</p>
          <p>We disclose data to authorities only when the law requires it, and we push back on requests that are not lawful.</p>
        </>},
        { id: 'retention', title: 'How long we keep it', body: <>
          <ul>
            <li>Sign-in codes: 10 minutes, and they work once.</li>
            <li>Signed-in sessions: until you sign out or they expire (30 days by default).</li>
            <li>Watch history (your Trail): until you remove it in <Link href="/trail">Trail</Link>.</li>
            <li>Videos, comments, collections: until you delete them. Deleted videos are removed from storage with all their files.</li>
            <li>Reports, notices, moderation decisions and the security log: as long as needed for safety and legal claims.</li>
            <li>Your account: until you ask us to close it; then we delete or anonymise your data, except what the law requires us to keep.</li>
          </ul>
        </>},
        { id: 'cookies', title: 'Cookies and storage on your device', body: <>
          <p>We use only what Free Me needs to work. No advertising or analytics cookies.</p>
          <ul>
            <li><code>__Host-fm_session</code> (or <code>fm_session</code> on development servers): keeps you signed in.</li>
            <li><code>fm_oauth</code>: a short-lived cookie that protects the &ldquo;Sign in with Google&rdquo; step.</li>
            <li><code>fm_theme</code>: your light or dark theme choice.</li>
            <li>Browser storage for player settings (volume, mute, speed), your recent searches in Find, and unfinished uploads, so you can resume them.</li>
          </ul>
        </>},
        { id: 'rights', title: 'Your rights', body: <>
          <p>Depending on where you live, you can ask to access, correct, delete or receive a copy of your personal data, to restrict or object to how we use it, and to withdraw consent where we rely on it. You can already change your profile in <Link href="/settings">Settings</Link>, see and end your sessions, clear your history and delete your videos and comments yourself.</p>
          <p>For anything else, contact us (below). We answer within one month. You can also complain to your data protection authority (in Rwanda, the National Cyber Security Authority; in the EU, the authority of your country).</p>
        </>},
        { id: 'children', title: 'Children', body: <p>Free Me is not for children under 13. Creators must mark videos made for children; on those videos comments are turned off. If you believe a child under 13 has an account, tell us and we will close it.</p> },
        { id: 'security', title: 'Security', body: <p>Connections are encrypted (HTTPS). We do not use passwords; sign-in codes and session tokens are stored only as one-way hashes. Private videos are served only through short-lived signed links. No system is perfectly secure, and we will tell you and the authorities about a breach as the law requires.</p> },
        { id: 'contact', title: 'Contact', body: <p>Write to {op} <Contact email={s.contactEmail} address={s.postalAddress} fallback={<>through the report forms on Free Me</>} /> about anything in this policy.</p> },
      ]}
    />
  );
}
