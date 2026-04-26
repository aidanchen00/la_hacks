# Prana GoodRx Shopping Agent

Searches GoodRx.com for prescription discount coupons and OTC products matching a wellness query within an allocated budget.

## What This Agent Does

Receives a `BudgetAllocation` from the Prana Budget Agent, uses BrowserUse to search GoodRx.com for the best matching product or coupon under the allocated price, and returns a `ShoppingResult` with the item name, price, URL, and stock status.

## Payment Protocol

Participates in the Fetch.ai Agent Payment Protocol as a seller:
`BudgetAllocation` → `RequestPayment` → `CommitPayment` → `CompletePayment` → `ShoppingResult`

## Part of

Prana multi-agent wellness navigation system — LA Hacks 2026.
