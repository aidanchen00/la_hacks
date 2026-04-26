# Prana — Wellness Care Navigation Agent

**Prana** is a non-diagnostic wellness education and care-navigation agent built for LA Hacks 2026.

## What This Agent Does

Send a natural-language health or wellness concern and receive a structured routing decision:

- **Urgency assessment**: `emergency` | `urgent` | `routine` | `wellness`
- **Recommended care path**: `doctor` | `pharmacy` | `mental_health` | `alt_medicine` | `self_care`
- **Summary**: 2-3 sentence wellness summary
- **Next actions**: Concrete steps to take
- **Disclaimers**: Safety and non-diagnostic notices

## Usage (ASI:One / OmegaClaw)

Send a `ChatMessage` with your wellness concern as `TextContent`. You'll receive:
1. `ChatAcknowledgement` (immediate)
2. Intermediate status message
3. Final `ChatMessage` with structured routing result as plain text
4. `EndSessionContent` to close the session

## Payment

Optional payment via Fetch.ai Agent Payment Protocol (Stripe under the hood) for premium navigation features.

## Safety

- **NOT a medical diagnosis tool**
- **NOT a replacement for licensed medical care**
- For emergencies, always call **911** or go to the nearest emergency room
- All routing decisions include appropriate disclaimers
