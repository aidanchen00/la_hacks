# Ranker Agent

Fetch.ai uAgent that ranks candidates produced by the search agents (CVS / Walgreens / GoodRx for pharmacy, ZocDoc / Healthgrades / Solv for doctor) and selects which ones to actually book or buy.

The ranker uses an LLM to score each candidate against the patient's intake summary, urgency, and per-agent budget, then chooses the subset (0–N) that should be booked. Results land in `ranker_selections` and are surfaced in the doctor / pharmacy sidebars.

Selected items flow through the existing budget agent's Payment Protocol wallets and end in a single Stripe checkout.
