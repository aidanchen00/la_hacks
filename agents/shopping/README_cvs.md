# Prana CVS Shopping Agent

Searches CVS.com for pharmacy products matching a wellness query within an allocated budget.

## What This Agent Does

Receives a `BudgetAllocation` from the Prana Budget Agent, uses BrowserUse to search CVS.com for the best matching product under the allocated price, and returns a `ShoppingResult` with the item name, price, URL, and stock status.

## Payment Protocol

Participates in the Fetch.ai Agent Payment Protocol as a seller:
`BudgetAllocation` → `RequestPayment` → `CommitPayment` → `CompletePayment` → `ShoppingResult`

## Part of

Prana multi-agent wellness navigation system — LA Hacks 2026.
