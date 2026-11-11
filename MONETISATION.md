# How Free Me makes money, and how creators are paid

Free Me has two sources of income, both paid up front with MTN MoMo or a card. Prices are the operator's to change (ENVIRONMENT.md → Payments).

| Income | Price | Who pays | What they get |
| --- | --- | --- | --- |
| **Premium** | $10 a month (3, 6 and 12 months too) | Viewers and creators | The verified badge next to their name, monetisation (earning from ads), Live Studio, the Premium dashboard |
| **Video ads** | $3 a day | Businesses | A 5–90 second video ad playing before videos of monetised creators, in the countries they choose, with a "Visit" button; uploaded and run from **Ad Studio** (`/studio/ads`, part of Premium), with results (shown, visits, rate) there. Ad videos are kept apart from the Space's videos and never appear in feeds or search. Viewers see the ad full-frame before the video starts, with a small *Sponsored* label, the business card with *Visit*, and *Skip* after 5 seconds; the video does not start until the ad is known (at most 1.5 seconds). Each campaign is reviewed by an administrator before it runs |

## The rules for ads

- Ads play **only on videos of monetised creators** (Premium members who joined monetisation).
- **At most 2 ads per video**: one before it, and one halfway through videos of 8 minutes or more. Never on Moments.
- Viewers can skip after 5 seconds. A viewer is counted once per ad and video every 30 minutes, so creators cannot inflate their share by replaying.

## How the ad money is shared

Each day, everything businesses paid for that day is split **60 / 30 / 10**:

- **60% to creators**, shared between monetised creators in proportion to the ads shown on their videos that day;
- **30% runs Free Me** (servers, video delivery, payments, support, moderation);
- **10% reserve** (refunds, chargebacks, growth).

The split is recorded with every entry in the creator's ledger. Earnings for a day are added the next morning; creators can request a Rwanda MTN MoMo withdrawal after account review and the configured minimum. A signed preview records the outgoing RWF rate, fee and amount to receive. The amount is reserved when requested. An administrator records the reference after sending it, or returns the balance once if it is rejected. Administration → Money contains the account review queue and a separate Flutterwave test-transfer panel.

## What creators can expect

The creator pool is `campaigns running × $3 × 60%` a day. A creator's share is their part of all ads shown.

| Ads running each day | Creator pool per day | per month (30 days) | A creator with 1% of ads shown, per month | with 5% |
| ---: | ---: | ---: | ---: | ---: |
| 20 | $36 | $1,080 | $10.80 | $54 |
| 100 | $180 | $5,400 | $54 | $270 |
| 500 | $900 | $27,000 | $270 | $1,350 |
| 2,000 | $3,600 | $108,000 | $1,080 | $5,400 |

Premium is the steadier income: 1,000 members bring $10,000 a month. That pays for servers and video delivery long before ads reach volume. It also makes monetisation self-selecting: a creator who earns more than $10 a month from ads gains from joining.

**Is $3 a day right?** Treat the current daily price as a pilot hypothesis. Measure valid impressions and advertiser outcomes before changing it. Effective CPM is campaign spend divided by valid impressions, multiplied by 1,000. A paid day has no guaranteed number of views unless the campaign terms explicitly provide one.

The Monetisation tab in Creator Hub has a calculator with the same formula.


## Payout pilot setup

Set `PAYOUT_RWF_PER_USD` to the operator's outgoing whole-RWF-per-USD rate and `PAYOUT_FEE_RWF` to the creator's fixed RWF payout fee. Without a rate, account review works but withdrawal previews stay closed. The preview expires after ten minutes, and its rate and fee are recorded on the request. A changed balance or account requires a new preview. Existing requests retain their destination and can still be manually settled.

Creators save their own-name Rwanda MTN wallet in Creator Hub. An administrator checks ownership outside the app and records the check reference before approving. This review does not perform government-ID verification or replace a payment provider's business onboarding.

`FLW_PAYOUT_TEST_KEY` enables the isolated Flutterwave v3 transfer sandbox. It accepts TEST keys only. Test results never settle creator requests or move ledger balances. Server IP approval and test wallet funding may be required by the provider. The panel keeps the reference on a timeout. Check the provider dashboard before starting another test.

Live automated transfers, additional countries, tips, memberships and brand commissions require separate implementation and commercial arrangements. Market sources and pilot measures are in [the creator pilot analysis](docs/CREATOR_PILOT.md).


## One-time audience support pilot

A creator with a reviewed Rwanda payout account can opt in on their Space or in Creator Hub → Money. Support is separate from advertising eligibility and does not require Premium. Editing payout details suspends new contributions until review; existing paid funds remain in the ledger.

Viewers sign in and choose $1, $3, $5, $10 or $20, with the actual collection currency shown before payment. Checkout uses the existing configured MTN MoMo, Flutterwave or manual collection method. The pilot takes zero platform commission: the operator absorbs collection costs and must confirm this is affordable before enabling the pilot. This is a pilot policy, not a permanent pricing promise. The 60% advertising split is unchanged. Free Sparks never create money.

Payment verification adds the contribution to **Pending settlement**, once. Administration → Money → Audience support lists received payments. An administrator checks the provider settlement and disputes before selecting **Settlement checked · clear funds**. Clearance moves the same money to **Available**, once, without increasing lifetime earnings again. Withdrawal uses the existing reviewed account and signed RWF preview.

`POST /support/:handle` requires a UUID `requestId`; retries must reuse that ID and the original amount, recipient, method and phone. A changed payment needs a new ID. The browser retains the ID across reloads in the same tab and resumes pending payments. A failed payment may be retried as a new request. Never automatically retry a timed-out checkout with a fresh ID.

Refunds and chargebacks are not automated in this phase. Leave disputed contributions pending; handle any refund with the collection provider and reconcile its pending ledger before clearing funds. Provider refunds do not automatically remove earnings in Free Me. Do not clear disputed funds or launch an unattended collection service with this manual pilot. Recurring creator memberships and sponsorship booking are future work.

Collection references for audience support are stored before sending a provider request. A lost or uncertain response stays pending and is checked with that reference rather than starting a second prompt. If the provider never received it, it eventually expires under the existing payment timeout policy; review uncertain transactions with the provider before asking a viewer to pay again. Flutterwave verification must also return the expected transaction reference. See the providers’ [MTN flow](https://momodeveloper.mtn.co.rw/content/html_widgets/aqnil.html) and [Flutterwave verification](https://developer.flutterwave.com/docs/transaction-verification) documentation.
