# Skills

This folder contains **SKILL.md** files — the open standard for discoverable agent capabilities published at [agentskills.io](https://agentskills.io).

SKILL.md-compatible coding agents — including **OmegaClaw**, **Claude Code**, **Cursor**, and **Codex** — automatically discover skills in this directory and activate them when a developer's request matches a skill's description.

## What's here

| Skill | Description |
|-------|-------------|
| [healthcare-test-fixtures](./healthcare-test-fixtures/SKILL.md) | Generate realistic synthetic healthcare triage fixtures by routing prompts to the Prana CareFlow agent on Agentverse |

## How skill discovery works

When you open this repo in OmegaClaw (or another SKILL.md-compatible agent), it scans for `SKILL.md` files and loads their frontmatter descriptions into the agent's context. When your request matches a skill's trigger phrases, the agent activates the skill and follows its instructions — including calling external agents on Agentverse.

## Using a skill with OmegaClaw

Skills are discovered automatically when you run OmegaClaw from this repo. No installation needed:

```bash
# OmegaClaw picks up skills from the repo root automatically
omegaclaw "Generate 5 triage scenarios with mixed urgency levels for my test suite"
```

## Using a skill with Claude Code

Copy the skill into Claude Code's skills directory:

```bash
cp -r skills/healthcare-test-fixtures ~/.claude/skills/
```

Then trigger it naturally in conversation:

```
"Give me fixtures for my healthcare app — I need one scenario per urgency level"
```

## The SKILL.md standard

See [agentskills.io](https://agentskills.io) for the full open standard specification,
including frontmatter schema, discovery rules, and how to publish your own skills.
