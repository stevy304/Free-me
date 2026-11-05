import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalPage } from '../LegalPage';
import { LAST_UPDATED, siteInfo } from '../site';

export const metadata: Metadata = { title: 'Copyright' };

export default async function Copyright() {
  const s = await siteInfo();
  const op = s.operatorName;
  return (
    <LegalPage
      path="/legal/copyright" title="Copyright" updated={LAST_UPDATED}
      intro={<>
        <p>Creators on Free Me must own what they upload or have permission to use it. If someone uploads your work without permission, you can ask us to remove it. This process follows notice-and-takedown laws such as the US Digital Millennium Copyright Act (17 U.S.C. &sect; 512), the EU Digital Services Act and Rwanda&apos;s law on intellectual property.</p>
        <p><Link href="/legal/copyright/notice" className="inline-flex h-10 items-center rounded-full bg-brand px-5 text-[14px] font-semibold text-on-brand no-underline hover:bg-brand-strong">Send a copyright notice</Link></p>
      </>}
      sections={[
        { id: 'before', title: 'Before you send a notice', body: <>
          <p>Check that the use is really not allowed. Many laws allow some uses without permission, such as quotation, criticism, review, news reporting, teaching or parody (&ldquo;fair use&rdquo; or &ldquo;fair dealing&rdquo;). Sending a notice you know to be false can make you liable for damages. If you are not sure, ask a lawyer.</p>
          <p>Only the owner of the rights, or someone authorised to act for them, can send a notice.</p>
        </>},
        { id: 'notice', title: 'What a notice must contain', body: <>
          <ul>
            <li>The work you own (for example its title and where it is published).</li>
            <li>The video on Free Me that you say infringes it, and what in it is yours (a time in the video helps).</li>
            <li>Your full name, email address and postal address.</li>
            <li>A statement that you believe in good faith the use is not authorised by the owner, its agent or the law.</li>
            <li>A statement, under penalty of perjury, that the notice is accurate and that you are the owner or authorised to act for them.</li>
            <li>Your signature (on the form, typing your full name).</li>
          </ul>
          <p>The quickest way is the <Link href="/legal/copyright/notice">online form</Link> (you need to be signed in, so we can tell you what happens). You can also send a notice <Contact email={s.copyrightEmail} address={s.postalAddress} fallback={<>through the online form</>} />.</p>
        </>},
        { id: 'after', title: 'What happens next', body: <>
          <ul>
            <li>We confirm receipt by email and a moderator reviews the notice.</li>
            <li>If it is complete and valid, we remove the video and tell the creator who sent the notice and which work it concerns. The removal is a copyright strike on the channel for 90 days.</li>
            <li>If it is incomplete or not valid, we tell you why and nothing is removed.</li>
          </ul>
        </>},
        { id: 'counter', title: 'Counter-notices', body: <>
          <p>If your video was removed because of a mistake or misidentification (for example, you own the work, have a licence or your use is allowed by law), you can send a counter-notice from the <strong>Removals and notices</strong> tab in Creator Hub. It must include your name, postal address, a statement under penalty of perjury that the removal was a mistake, and your consent to the jurisdiction of the courts and to accept legal papers from the person who sent the notice.</p>
          <p>We forward the counter-notice to that person. Unless they tell us within 10 business days that they have started a court action, we may restore the video 10 to 14 business days after we received the counter-notice, and the strike is lifted.</p>
        </>},
        { id: 'repeat', title: 'Repeat infringers', body: <p>We close the accounts of people who repeatedly infringe copyright. A channel with three copyright strikes in 90 days can be closed, and its videos removed.</p> },
        { id: 'agent', title: 'Designated contact', body: <p>{op} receives copyright notices {s.copyrightEmail || s.postalAddress ? <Contact email={s.copyrightEmail} address={s.postalAddress} fallback={null} /> : <>through the online form on this site</>}.</p> },
      ]}
    />
  );
}
