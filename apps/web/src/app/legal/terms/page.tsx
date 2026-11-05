import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalPage } from '../LegalPage';
import { LAST_UPDATED, siteInfo } from '../site';

export const metadata: Metadata = { title: 'Terms of Service' };

export default async function Terms() {
  const s = await siteInfo();
  const op = s.operatorName;
  return (
    <LegalPage
      path="/legal/terms" title="Terms of Service" updated={LAST_UPDATED}
      intro={<>
        <p>These terms are an agreement between you and {op} (&ldquo;we&rdquo;), which runs Free Me. They apply when you watch, upload, comment or otherwise use Free Me. By using the service you accept them. If you do not accept them, do not use Free Me.</p>
        <p>Also read the <Link href="/legal/privacy">Privacy Policy</Link>, the <Link href="/legal/guidelines">Community Guidelines</Link> and the <Link href="/legal/copyright">Copyright policy</Link>: they are part of these terms.</p>
      </>}
      sections={[
        { id: 'who', title: 'Who can use Free Me', body: <>
          <p>You must be at least 13 years old, and old enough in your country to agree to these terms without a parent (the age of digital consent, up to 16 in some countries). If you are under 18, a parent or guardian should read these terms with you.</p>
          <p>You may not use Free Me if we have closed your account before, or if the law forbids you from receiving the service.</p>
        </>},
        { id: 'account', title: 'Your account', body: <>
          <p>You sign in with Google or with a one-time code sent to your email address. Keep access to that email account secure: anyone who controls it can sign in as you. Tell us at once if you think someone else has used your account.</p>
          <p>You can see and end your signed-in sessions in <Link href="/settings">Settings</Link>. You are responsible for what happens through your account.</p>
        </>},
        { id: 'content', title: 'Your content', body: <>
          <p>You keep the rights you have in the videos, thumbnails, descriptions and comments you post (&ldquo;your content&rdquo;).</p>
          <p>So that we can run the service, you give {op} a worldwide, non-exclusive, royalty-free licence to host, store, copy, transcode into different formats and sizes, display, distribute and promote your content on Free Me, for as long as it is on Free Me and for a reasonable time after you delete it (for backups and legal holds). You also allow other users to watch and share links to your public and unlisted content through Free Me. This licence does not let us sell your content to others.</p>
          <p>You promise that you own your content or have every permission it needs (including from people who appear in it and for any music), and that it follows these terms and the law.</p>
        </>},
        { id: 'rules', title: 'Rules you agree to follow', body: <>
          <ul>
            <li>Follow the <Link href="/legal/guidelines">Community Guidelines</Link>.</li>
            <li>Do not upload content you do not have the rights to.</li>
            <li>Do not try to break, overload or get around the security of Free Me, or access other people&apos;s accounts or private videos.</li>
            <li>Do not collect data about users with automated tools, or inflate views, likes, follows or comments by any artificial means.</li>
            <li>Do not use Free Me to send spam, scams or malware.</li>
          </ul>
        </>},
        { id: 'moderation', title: 'Moderation, removals and strikes', body: <>
          <p>Anyone can report a video. Moderators review reports and may remove content that breaks the rules. When we remove one of your videos we email you the reason. A removal is a strike on your channel for 90 days; we may suspend accounts that collect repeated strikes, and we close the accounts of repeat copyright infringers.</p>
          <p>If you think a decision is wrong, reply to the removal email to ask for a review. For copyright removals you can send a counter-notice from Creator Hub (see the <Link href="/legal/copyright">Copyright policy</Link>).</p>
        </>},
        { id: 'service', title: 'The service', body: <>
          <p>We work to keep Free Me available and your videos safe, but we provide the service &ldquo;as is&rdquo;. We may change, add or remove features. Keep your own copies of your original videos: Free Me is not a backup service.</p>
          <p>Video files you upload are processed into streaming versions. Processing can fail for damaged or unsupported files; we will tell you when it does.</p>
        </>},
        { id: 'ending', title: 'Ending the agreement', body: <>
          <p>You can stop using Free Me at any time and delete your videos from Creator Hub. To close your account, contact us (see below).</p>
          <p>We may suspend or close an account that seriously or repeatedly breaks these terms, or when the law requires it. Where we can, we will tell you why.</p>
        </>},
        { id: 'liability', title: 'Liability', body: <>
          <p>Nothing in these terms limits liability that cannot be limited by law, including for death or personal injury caused by negligence, or for fraud. Otherwise, to the extent the law allows, {op} is not liable for indirect or consequential losses, or for loss of data, profits or business, and our total liability is limited to the greater of the amount you paid us in the 12 months before the claim and the equivalent of 100 US dollars.</p>
          <p>If you are a consumer, you keep all the rights that consumer law in your country gives you.</p>
        </>},
        { id: 'changes', title: 'Changes to these terms', body: <p>We may update these terms. If a change matters, we will tell you before it applies, for example by email or a notice on Free Me. Continuing to use Free Me after the change means you accept it.</p> },
        { id: 'law', title: 'Law and disputes', body: <>
          <p>{s.jurisdiction ? <>These terms are governed by the law of {s.jurisdiction}, and its courts have jurisdiction, </> : <>These terms are governed by the law of the country where {op} is established, and its courts have jurisdiction, </>}except that if you are a consumer you may also bring a claim in the courts of the country where you live and rely on its mandatory consumer protections.</p>
        </>},
        { id: 'contact', title: 'Contact', body: <p>You can reach {op} <Contact email={s.contactEmail} address={s.postalAddress} fallback={<>through the report forms on Free Me</>} />.</p> },
      ]}
    />
  );
}
