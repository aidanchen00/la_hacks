# Prana Budget Agent

Coordinates pharmacy product shopping across multiple platforms on behalf of the Prana wellness system.

## What This Agent Does

Receives a `BudgetRequest` from the Prana orchestrator and splits the total budget equally across four seller agents (CVS, Walgreens, GoodRx, Amazon). Manages the Payment Protocol handshake with each seller, collects results, and creates a Stripe multi-item checkout session.

## Flow

1. Receives `BudgetRequest` (run_id, query, total_budget_usd)
2. Allocates budget equally to CVS, Walgreens, GoodRx, and Amazon seller agents
3. Runs `RequestPayment` → `CommitPayment` → `CompletePayment` with each seller
4. Collects `ShoppingResult` from all sellers
5. Builds a Stripe checkout session and returns a `SpecialistResult` with checkout URL

## Part of

Prana multi-agent wellness navigation system — LA Hacks 2026.
