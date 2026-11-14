# Free Me: affordable advertising and creator economics

Decision date: 14 November 2026. Product choices below are launch hypotheses, not measured demand or guaranteed profit.

## Recommendation

Launch direct prepaid campaigns in Rwanda with a **$2 total starter budget** and **$1 CPM** (1,000 ad impressions), subject to the configured cost floor. Do not force a daily spend or sell unlimited delivery. Keep 70% of earned long-video ad revenue for the creator pool, and 60% of Moments revenue for its creator pool. Free Me's retained share must fund payment costs, delivery, operations and reserves. Larger creator percentages alone cannot guarantee larger payouts.

The low entry amount is the acquisition offer. The operating model must encourage repeat top-ups and larger campaigns without discounting below cost. At $2, the default campaign can buy up to 2,000 ad impressions, not 2,000 customers. Views may repeat across people and an impression can be skipped. Local-currency estimates use the configured payment method's exchange rate and checkout rounding, not an external live exchange-rate feed.

Existing administrator prices and environment settings override new defaults. Review them before a real launch. No production environment or stored prices are changed by this branch.

## What the evidence supports

| Verified public fact | Implication for Free Me |
| --- | --- |
| YouTube lists 55% of net watch-page advertising revenue for participating creators; Shorts uses 45% of the allocated Creator Pool. | 70%/60% are larger stated percentages, but these denominators and licensing rules differ. Do not advertise guaranteed higher cash earnings or a universal best-in-market payout. |
| Google supports CPV and impression-based bidding; skipping before 30 seconds is not universally free. | Disclose Free Me's actual impression billing clearly; never market these impressions as completed views. |
| Flutterwave's Rwanda pricing page lists 3.5% mobile-money collections, 4.8% card collections, 500 RWF mobile-money transfers and 2,000 RWF bank transfers, excluding applicable taxes. | Tiny transactions and withdrawals have real costs. The default 6% fee allowance is a conservative planning assumption, not an all-in quote; use the contracted effective rate. |
| GSMA identifies affordability, digital skills and relevant content as barriers to African mobile-internet adoption. | Prioritize small downloads, local-language content and low entry budgets. This is an inference from the evidence, not proof of advertiser demand. |
| Hetzner lists included traffic for selected EU cloud plans and separate dedicated-server terms. | Use actual invoices, delivery location, throughput and cache hit rates. Included traffic does not make storage, processing or operations free. |

There is no independently verified Rwanda YouTube CPM, creator rate card or Free Me conversion rate in this analysis. Do not copy Uganda prices into Rwanda forecasts. Telecom subscriptions are not distinct people, active video viewers or Free Me users. No continent-wide revenue forecast is justified by the available evidence.

## Initial buyers and route to market

Sell assisted campaigns to Rwandan businesses where outcomes can be observed: clothing sellers with product codes; restaurants with offer codes; training providers with application links; event organizers with ticket links; and tourism businesses with enquiries. These are prospecting hypotheses. Ask for recent campaign spend and results rather than inferring budgets from business size.

Begin with 10 paying advertisers and 20 regularly publishing creators as a commercial cohort. Use the $2 option for a small trial, and $5/$10 presets for longer observation. Avoid unlimited free ad credits; any promotion must have a recorded subsidy budget and must not generate unfunded creator earnings. Track spend, actual impressions, valid clicks, advertiser-reported enquiries and repeat purchases. WhatsApp links or promotion codes can support manual outcome attribution; a first-party sales-conversion pixel and attribution service are not implemented here.

Enter additional countries only after there is a concentrated audience, advertiser demand, workable payment routes and positive measured economics there. Kenya, Uganda and Tanzania are candidates for research, not an automatic expansion order or a shared price region. Diaspora-targeted campaigns should follow actual viewer location, not the uploader's nationality.

## Cost model and sensitivity

The protected price floor uses the more generous 70% creator allocation. Let C be total allocated costs per 1,000 paid impressions, F the collection fee fraction, and M the desired remaining fraction:

`minimum CPM = ceil(C / (0.30 - F - M))` in USD cents.

C must include content delivery when no paid ad is available, storage, encoding, payout fees borne by Free Me, moderation, support, refunds/chargebacks not otherwise excluded from recognized revenue and allocated fixed overhead. Do not divide costs by all video plays and label them costs per paid impression. Include statutory obligations in the accounting basis rather than silently treating taxes as profit. No new tax engine is implemented here.

The default F is 6%, M is 10%. The 10% remainder includes reserves and reinvestment; it is not a promise of distributable net profit. Unknown costs produce `UNVERIFIED_COSTS`; the price floor is active only once costs are supplied.

| Hypothetical C per 1,000 paid impressions | Protected minimum CPM | Creator pool at that CPM | Remaining after creators, 6% collection and C |
| ---: | ---: | ---: | ---: |
| $0.10 | $0.72; configured $1 wins | $0.70 at $1 | $0.14 at $1 |
| $0.14 | $1.00 | $0.70 | $0.10 |
| $0.20 | $1.43 | $1.001 before settlement rounding | $0.1432 |
| $0.50 | $3.58 | $2.506 before settlement rounding | $0.3592 |

These are mathematical scenarios, not measured Hetzner costs. When costs rise, raise the unit price for new commitments or improve fill and delivery efficiency. Do not quietly reduce a creator's disclosed percentage. Existing prepaid campaigns retain their rate, with any losses on those commitments borne by the operator; below-current-rate top-ups and unpaid drafts require a newly priced campaign.

Payout fees deserve separate attention: a 500 RWF transfer fee consumes 5% of a 10,000 RWF payout but only 1% of a 50,000 RWF payout, before fee taxes. Offer a transparent scheduled/batched payout policy where commercially possible. This branch preserves existing payout minimums and fee settings; it does not introduce a new fee waiver.

## What this branch implements

- $2 default starting budget and small preset budgets in Ad Studio, with estimates in a configured local payment currency.
- 70/20/10 long-video split and 60% Moments pool from UTC earning day 2026-11-14. Historical days retain their earlier policy; settled ledger entries remain unchanged.
- Campaign-specific paid allocations, revenue bounded by funded budget, exclusion of free campaigns from paid allocations, and exclusion of undelivered funds from revenue.
- Cost model, admin status and minimum effective CPM enforced when new campaigns are created, including administrator price overrides. Below-current-rate unpaid drafts/top-ups cannot extend old pricing.
- Creator-facing disclosures and explicit impression billing language.

It extends existing campaign creation, review, payment, delivery and earnings flows. It does not add an auction, creator sponsorship marketplace, automated advertiser refunds, automated live payouts or an automated conversion-attribution service. Expired unspent funds remain tracked on the campaign and require an operator-reviewed refund/make-good. These operational tasks must not be described as automated.

## Release and commercial gates

Before taking public advertiser money, set production payment credentials through the existing settings workflow, confirm the actual checkout currencies/rates and fees, and enter measured cost assumptions. Use approved test payments first. Fund and test the payout route separately. No real payments are initiated by this implementation.

For the first cohort, review weekly: paid impressions per 1,000 content plays, realized CPM, unspent balances, chargebacks/refunds, valid click rates, repeat advertisers, creator payout accuracy and cost per 1,000 paid impressions. A reasonable proposed expansion gate is positive fully allocated economics for two consecutive months and at least half of the cohort repurchasing; these are operating targets, not research findings. Pause new selling if delivery or payout reconciliation fails.

## Sources checked

- YouTube partner earnings: https://support.google.com/youtube/answer/72902
- Google video formats and billing: https://support.google.com/google-ads/answer/2375464
- Flutterwave Rwanda prices: https://flutterwave.com/rw/pricing/
- Flutterwave Rwanda mobile-money transfers and approval prerequisites: https://developer.flutterwave.com/docs/rwanda-2
- GSMA Mobile Economy Africa 2026: https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-economy/africa/
- Hetzner traffic terms: https://docs.hetzner.com/robot/general/traffic/

Verify provider terms again before launch. Commercial approval, taxes and actual contractual fees can differ from a public pricing page.
