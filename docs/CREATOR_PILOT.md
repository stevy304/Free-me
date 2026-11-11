# Free Me creator payout pilot

## Market evidence

The EICV7 survey reports mobile phones in 85% of Rwanda's households and home internet access in 30% in 2023/24. The home internet figures are 56% in urban areas and 19% in rural areas. These are household measures, not a count of potential paying video viewers.

Source — National Institute of Statistics of Rwanda, EICV7 Utilities and Amenities 2023/24
https://statistics.gov.rw/statistical-publications/ict-water-sanitation-energy-tourism-and-transport/eicv7-thematic-report-utilities-and-amenities-202324

FinScope 2024 reports that approximately 86% of adults used mobile money and 77% held registered mobile money accounts in their own names. This supports testing wallet payouts, but does not establish demand for a new video platform.

Source — Ministry of Finance and Economic Planning, FinScope launch
https://www.minecofin.gov.rw/news-detail/96-of-rwandans-are-financially-included-finscope-survey-2024

Flutterwave documents RWF wallet transfers with transaction approval, API enablement, server IP whitelisting and funded wallets as prerequisites. Documented destination support does not establish that Free Me has an approved merchant account or approved business model.

Sources — Flutterwave Rwanda transfers and testing
https://developer.flutterwave.com/docs/rwanda-2
https://developer.flutterwave.com/docs/testing

## Product choices

Start with Rwanda MTN wallet account review, a transparent withdrawal preview and manual settlement. Keep payout support separate from Premium badges. The Flutterwave panel runs test transfers separately from creator funds.

Keep the current configured minimum and revenue split during the pilot. These are business hypotheses. No fixed cash reward is introduced for free Sparks. Additional payout routes open after provider and operational arrangements are confirmed.

Keep the viewer experience light on data. Reach creators through existing communities and their diaspora audiences. Research teacher-led educational videos, local entertainment and practical skills as possible initial niches. These are candidate segments to interview, not proven winners.

## Proposed validation cohort

Recruit 20 creators and five local advertisers for an initial four-week pilot, subject to their participation. These are proposed operating targets. No demand study or interviews have been completed.

Interview creators about their current income, payout costs, audience locations, data costs and willingness to use Free Me. Ask advertisers what action they want viewers to take, what they can pay and whether a repeat campaign is worthwhile.

Measure the following before expanding.

| Question | Measure |
| --- | --- |
| Can creators receive earnings reliably? | Account-review completion, rejected accounts, payout completion, actual fees and time to receive |
| Do advertisers see value? | Valid impressions, clicks, cost per click, reported outcomes and repeat purchases |
| Can Free Me cover delivery? | Revenue after refunds and provider costs, creator allocation, video delivery and support cost |
| Do viewers return? | Returning viewers, watch completion, startup time and buffering on mobile connections |
| Are earnings understood? | Creator feedback on estimated, available, reserved and paid amounts |

Calculate effective CPM as spend divided by valid impressions times 1,000. Compare acquisition and operating costs with actual collected revenue. Do not infer local ad prices from a hypothetical number of views.

## Release boundary

This release implements account review, signed withdrawal previews, reservation and settlement safeguards, a public availability page and an isolated Flutterwave test-transfer adapter. It does not activate live provider disbursements or perform automatic identity verification. A legal and payment-provider review of the actual business arrangements remains necessary before any expansion.
