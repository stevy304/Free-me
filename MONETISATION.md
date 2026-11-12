# How Free Me makes money, and how creators are paid

Free Me has two sources of income, both paid up front with MTN MoMo or a card. Prices are the operator's to change (ENVIRONMENT.md → Payments).

| Income | Price | Who pays | What they get |
| --- | --- | --- | --- |
| **Premium** | $10 a month (3, 6 and 12 months too) | Viewers and creators | The verified badge next to their name, monetisation (earning from ads), Live Studio, the Premium dashboard |
| **Video ads** | $3 a day, at $1 per 1,000 views (up to 3,000 views a day) | Businesses | A 5–90 second video ad playing before videos of monetised creators, in the countries they choose, with a "Visit" button; uploaded and run from **Ad Studio** (`/studio/ads`, part of Premium), with results (shown, visits, rate) there. Ad videos are kept apart from the Space's videos and never appear in feeds or search. Viewers see the ad full-frame before the video starts, with a small *Sponsored* label, the business card with *Visit*, and *Skip* after 5 seconds; the video does not start until the ad is known (at most 1.5 seconds). Each campaign is reviewed by an administrator before it runs |

## The rules for ads

- **Priced per 1,000 views.** A campaign is still bought in days ($3 each), but each day buys a set number of views: $3 ÷ $1 per 1,000 = 3,000. The campaign gets at most that many views each UTC day, and never more than its budget in total, so a few campaigns cannot take every ad slot for a flat fee. Views not delivered in the days bought keep running for as many days again (the make-good period). Both prices are the operator's to change (`AD_PRICE_PER_DAY_USD_CENTS`, `AD_CPM_USD_CENTS`, or Administration → Money).
- Campaigns created before per-view pricing keep the old rule (paid per day, no view limit).

- Ads play **only on videos of monetised creators** (Premium members who joined monetisation).
- **At most 2 ads per video**: one before it, and one halfway through videos of 8 minutes or more. Never on Moments.
- Viewers can skip after 5 seconds. A viewer is counted once per ad and video every 30 minutes, so creators cannot inflate their share by replaying.

## How the ad money is shared

Each day, the money earned from ads that day is split **60 / 30 / 10**. For campaigns priced per 1,000 views that is the views delivered that day (at $1 per 1,000 by default); budget a campaign could not deliver by the end of its make-good period is counted on that last day, because it was paid for. (Older campaigns priced per day count what they paid for the hours they ran.)

- **60% to creators**, shared between monetised creators in proportion to the ads shown on their videos that day;
- **30% runs Free Me** (servers, video delivery, payments, support, moderation);
- **10% reserve** (refunds, chargebacks, growth).

The split is recorded with every entry in the creator's ledger. Earnings for a day are added the next morning; creators can request a Rwanda MTN MoMo withdrawal after account review and the configured minimum. A signed preview records the outgoing RWF rate, fee and amount to receive. The amount is reserved when requested. An administrator records the reference after sending it, or returns the balance once if it is rejected. Administration → Money contains the account review queue and a separate Flutterwave test-transfer panel.

## What creators can expect

When campaigns deliver all their views, the creator pool is `campaigns running × $3 × 60%` a day; with fewer views, it is `views delivered ÷ 1,000 × $1 × 60%`. A creator's share is their part of all ads shown.

| Ads running each day | Creator pool per day | per month (30 days) | A creator with 1% of ads shown, per month | with 5% |
| ---: | ---: | ---: | ---: | ---: |
| 20 | $36 | $1,080 | $10.80 | $54 |
| 100 | $180 | $5,400 | $54 | $270 |
| 500 | $900 | $27,000 | $270 | $1,350 |
| 2,000 | $3,600 | $108,000 | $1,080 | $5,400 |

**Prices per country.** $10 a month is a lot in many countries. `PREMIUM_PRICE_BY_COUNTRY` (or Administration → Money → Prices) sets a lower price where the viewer's profile country is listed, e.g. `RW=300` for $3 in Rwanda. A profile country can be changed, so keep regional prices modest. Paying by MoMo in RWF needs a Rwandan number, which limits misuse.

Premium is the steadier income: 1,000 members bring $10,000 a month. That pays for servers and video delivery long before ads reach volume. It also makes monetisation self-selecting: a creator who earns more than $10 a month from ads gains from joining.

**Are $3 a day and $1 per 1,000 views right?** Treat both as pilot hypotheses. Measure valid impressions and advertiser outcomes before changing them. A paid day buys *up to* its views (3,000 by default); it does not guarantee them unless the campaign terms explicitly say so. As the audience grows, raise the price per 1,000 views towards market rates: delivery costs money for every view, and a flat daily price with unlimited views would sell ads for less than they cost to show.

The Monetisation tab in Creator Hub has a calculator with the same formula.


## Payout pilot setup

Set `PAYOUT_RWF_PER_USD` to the operator's outgoing whole-RWF-per-USD rate and `PAYOUT_FEE_RWF` to the creator's fixed RWF payout fee. Without a rate, account review works but withdrawal previews stay closed. The preview expires after ten minutes, and its rate and fee are recorded on the request. A changed balance or account requires a new preview. Existing requests retain their destination and can still be manually settled.

Creators save their own-name Rwanda MTN wallet in Creator Hub. An administrator checks ownership outside the app and records the check reference before approving. This review does not perform government-ID verification or replace a payment provider's business onboarding.

`FLW_PAYOUT_TEST_KEY` enables the isolated Flutterwave v3 transfer sandbox. It accepts TEST keys only. Test results never settle creator requests or move ledger balances. Server IP approval and test wallet funding may be required by the provider. The panel keeps the reference on a timeout. Check the provider dashboard before starting another test.

Live automated transfers, additional countries, tips, memberships and brand commissions require separate implementation and commercial arrangements. Market sources and pilot measures are in [the creator pilot analysis](docs/CREATOR_PILOT.md).
