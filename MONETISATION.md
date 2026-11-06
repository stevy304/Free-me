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

The split is recorded with every entry in the creator's ledger. Earnings for a day are added the next morning; creators withdraw to MTN MoMo from $10, and an administrator sends the transfer and records its reference (Administration → Money).

## What creators can expect

The creator pool is `campaigns running × $3 × 60%` a day. A creator's share is their part of all ads shown.

| Ads running each day | Creator pool per day | per month (30 days) | A creator with 1% of ads shown, per month | with 5% |
| ---: | ---: | ---: | ---: | ---: |
| 20 | $36 | $1,080 | $10.80 | $54 |
| 100 | $180 | $5,400 | $54 | $270 |
| 500 | $900 | $27,000 | $270 | $1,350 |
| 2,000 | $3,600 | $108,000 | $1,080 | $5,400 |

Premium is the steadier income: 1,000 members bring $10,000 a month. That pays for servers and video delivery long before ads reach volume. It also makes monetisation self-selecting: a creator who earns more than $10 a month from ads gains from joining.

**Is $3 a day right?** Video ads in East Africa sell for roughly $2.50–3.50 per 1,000 views (CPM). At $3 a day, a business pays the same as about 1,000 views a day, and with more viewers on Free Me each campaign is worth more to them. When a campaign regularly shows far more than 1,000 times a day, raise the daily price (`AD_PRICE_PER_DAY_USD_CENTS`) or sell more, shorter slots. When creators' share of a day rises, every monetised creator earns more.

The Monetisation tab in Creator Hub has a calculator with the same formula.
