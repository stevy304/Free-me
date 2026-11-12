# How Free Me makes money, and how creators are paid

> **Internal.** How revenue is divided (creators' shares, what pays for what) is for the team, not for users: the app
> shows people what they get (quality, uploads, live streaming, badges), never where the money goes. Keep this
> repository private if these numbers should stay confidential.

**How the app presents plans.** Two groups of three on `/plans`: *For viewers* (Free, Plus, Family & TV) and *For
creators* (Starter, Creator pass, Pro). Businesses advertise and get verified in Ad Studio.

## Plans

Watching is free. Plans are **paid ahead** (mobile money cannot renew by itself), for 1, 3, 6 or 12 months (the Creator pass for 1 or 2 years), with MTN MoMo, Airtel Money, a card (Flutterwave) or by hand. Paying early adds the time to the end, and a reminder email goes out three days before a plan ends. Prices are in US cents, with a price per country where incomes differ. The defaults below are set in ENVIRONMENT.md and can be changed by administrators in Administration → Money.

| Plan | Rwanda (VAT included) | Elsewhere | For | Includes |
| --- | --- | --- | --- | --- |
| **Free** | 0 | 0 | Everyone | Everything, with short ads, up to 720p; 3 uploads to try creating |
| **Creator pass** | about RWF 2,900 a year | $2 a year | New creators | Up to 50 uploads in any 365 days; videos stay online if it ends |
| **Plus** | RWF 2,500 a month | $3 | Viewers | No ads, every quality; half goes to the creators they watch |
| **Family & TV** | RWF 9,000 a month | $12 | Homes | Plus for up to 4 people (the holder adds members by email) |
| **Pro** (Premium) | RWF 6,000 a month | $10 | Creators | Gold Premium badge, ad earnings, Live, unlimited uploads, Plus included |
| **Ad funds** | from $7 | from $7 | Businesses | Spent at $1 per 1,000 views as the ad is shown (`AD_MIN_BUDGET_USD_CENTS`, `AD_CPM_USD_CENTS`); any Space can advertise, every ad is reviewed |
| **Verified business** | $10 a year | $10 a year | Businesses | Teal Verified badge; no other Space can use the name. Checked by an administrator first, paid after approval (`VERIFICATION_PRICE_USD_CENTS`) |

**Round prices.** Mobile money charges in francs are rounded to the nearest RWF 100 (RWF 2,494 becomes 2,500), the same on the page and in the charge.

**Members pay creators too.** Plus and Family members see no ads, so creators would earn nothing from them. Each day, `SUBSCRIPTION_CREATOR_SHARE_PERCENT` (50%) of the Plus and Family money of that day (each payment spread over the days it pays for) is shared between monetised Spaces by the watch time members gave their videos that day. It appears in Creator Hub as "Plus and Family members' share". The share is of what members pay, VAT included: lower the percentage if you want to share the amount after VAT (for example 42% of the price is about 50% after 18% VAT).

**Prices in Rwanda.** The defaults compare with what people already pay: Canal+ from RWF 5,000 a month, Netflix Mobile about $3. A Plus member who watches 30 minutes a day would bring only about $0.06 a month in ads, so RWF 2,500 is far more than ads earn from them. Check exchange rates (`MOMO_RATE_PER_USD`) and the country prices every few months.

Free Me has two sources of income, both paid up front with MTN MoMo or a card. Prices are the operator's to change (ENVIRONMENT.md → Payments).

| Income | Price | Who pays | What they get |
| --- | --- | --- | --- |
| **Premium** | $10 a month (3, 6 and 12 months too) | Viewers and creators | The gold **Premium badge** next to their name, the Creator pass, monetisation (earning from ads), Live Studio, the Premium dashboard |
| **Creator pass** | $2 a year (2 years too) | Creators | Uploading after the free uploads (3 per Space by default), up to 50 a year. Pays for encoding and storage |
| **Video ads** | $3 a day, at $1 per 1,000 views (up to 3,000 views a day) | Businesses | A 5–90 second video ad playing before videos of monetised creators, in the countries they choose, with a "Visit" button; uploaded and run from **Ad Studio** (`/studio/ads`, part of Premium), with results (shown, visits, rate) there. Ad videos are kept apart from the Space's videos and never appear in feeds or search. Viewers see the ad full-frame before the video starts, with a small *Sponsored* label, the business card with *Visit*, and *Skip* after 5 seconds; the video does not start until the ad is known (at most 1.5 seconds). Each campaign is reviewed by an administrator before it runs |

## Creator pass

Every Space can upload **3 videos free** (`CREATOR_FREE_VIDEOS`), so anyone can try Free Me before paying. After that, uploading needs the **Creator pass**, $2 a **year** (`CREATOR_PASS_PRICE_USD_CENTS`), for up to 50 uploads in any 365 days (`CREATOR_PASS_VIDEOS_PER_YEAR`; deleting a video frees its place). Pro (Premium) includes it, with no limit.

- **Only new uploads need it.** Managing videos, earnings, removal notices and counter-notices in Creator Hub stays free. Published videos stay online when a pass ends: viewers and the creator's audience never lose them. Removing videos because a creator stopped paying would hurt viewers and Free Me's reputation more than it saves.
- **Deleting a draft does not give a free upload back** (`Channel.uploadCount` counts uploads ever started).
- **Creators you invite** at launch: Administration → Money → *Give Creator pass* (by email), so the first creators are not asked to pay before there is an audience.
- **Where the money goes**: think of half (about $1) as the encoding budget (CPU now, a rented NVIDIA GPU later, see DEPLOYMENT.md) and half as storage.

## Badges

| Badge | Looks | Means | How to get it |
| --- | --- | --- | --- |
| **Premium** | Gold seal with a star | The owner is a Premium member | $10 a month (Premium) |
| **Verified** | Teal seal with a tick | Free Me checked who runs this Space | Only an administrator sets it (Administration → Money → verification), after checking identity |

They look different on purpose. A badge anyone can buy must never be mistaken for a checked identity: otherwise someone could pay $10 and pass as a bank, a ministry or a famous artist.

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

## Ad funds

A business adds funds to an ad (at least $7) and chooses how many days to spread the views over (7 by default). The
ad is shown up to `funds ÷ days` worth of views a day at $1 per 1,000 views; funds not spent in those days keep being
spent for up to twice as long, and at least 30 days from the start. Advertising no longer needs Premium. For reference,
YouTube's creators in Rwanda and the region earn roughly $0.30-1.50 per 1,000 views of long videos, and almost nothing
on Shorts; $1 per 1,000 ad views is in line with that, and Moments carry no ads.

## Verified business

1. In Ad Studio the business sends its registered name, RDB registration or tax number, a phone number and website.
2. An administrator checks them outside the app (RDB, a call) and approves or rejects with a reason (Administration → Money).
3. Approved, the business pays for a year; the teal Verified badge turns on. No other Space can then use that name,
   and the business can only change its name through Free Me.
4. After a year the badge goes; the approval stays, so renewing needs no new check.
