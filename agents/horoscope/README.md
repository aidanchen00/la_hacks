# Prana Horoscope Agent

A paid horoscope reading agent built on the Fetch.ai uAgents Payment Protocol.

## What This Agent Does

Receives a `HoroscopeRequest` with a zodiac sign, charges a small fee via the Payment Protocol (seller role), and returns a daily horoscope reading as a `HoroscopeResult`.

## Flow

1. Receives `HoroscopeRequest(run_id, sign, name)` from any caller
2. Sends `RequestPayment` for $0.99 USD via Stripe
3. On `CommitPayment`, returns `CompletePayment` and a `HoroscopeResult` with the daily reading
4. On `RejectPayment`, ends the session quietly

## Supported Signs

aries · taurus · gemini · cancer · leo · virgo · libra · scorpio · sagittarius · capricorn · aquarius · pisces

## Part of

Prana multi-agent wellness navigation system — LA Hacks 2026. The horoscope agent rounds out the alt-medicine surface area alongside meditation and self-care suggestions.
