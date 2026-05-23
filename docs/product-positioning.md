# Browsy Product Positioning

## One-line

> Browsy turns one-off browser-agent tasks into durable, testable, reviewable automation harnesses.

## What problem it solves

Browser automation for web workflows is solved at two extremes:

1. **Low-code recorders** (Playwright codegen, Selenium IDE, browser macros): fast to create, brittle in production. No business logic, no safety gates, no field-source mapping.
2. **AI browser agents** (Stagehand, Skyvern, Browser Use, OpenClaw): autonomous and flexible, but expensive, non-deterministic, hard to audit, and tend to get stuck or take wrong actions at scale.

Neither extreme is good for **repeatable, business-critical workflows** that run every day.

Browsy fills the gap: a request-driven factory that produces a boring, deterministic, field-mapped, safety-gated automation harness — the kind a human can read, test, and trust.

## Target user

A developer or technical operator who:

- Has a repeatable browser workflow (uploading, downloading reports, filling forms, managing accounts)
- Has tried manual execution or ad-hoc scripting and wants something more maintainable
- Wants the help of a coding agent to write the automation, but wants to inspect and control what it does
- Cannot afford autonomous agents making mistakes on payment, legal, or destructive actions

## Use cases

- **Reporting downloads:** Authenticated portal that has no API; run discovery, map the download buttons, automate the navigation, download and save artifacts.
- **Release/upload workflows:** Upload metadata and media to platforms that accept human-driven submission; automate all safe fields, leave final submit and legal terms manual.
- **Form automation:** Fill application or admin forms from a structured manifest; skip payment and legal checkboxes; pause before submit.
- **Audit trails:** Every run produces logs, screenshots, filled/skipped/errors JSON — ready for human review.
- **Agent-assisted harness building:** Point a coding agent at Browsy, give it a filled request file, and get a working automation harness with safety gates already in place.

## What Browsy is NOT

- **Not a general browser agent.** Browsy does not reason about page state dynamically. It executes a known field map against a known page structure.
- **Not a no-code tool.** Browsy produces code. A developer or coding agent builds and maintains the harness.
- **Not a scraper.** Browsy is for form submission and task execution workflows, not bulk data extraction.
- **Not a testing framework.** Browsy uses Playwright but is not Playwright codegen. It adds business intent, safety policy, and human checkpoints on top.
- **Not autonomous.** Final submits, payment actions, legal certifications, and destructive changes always require a human.

## Non-goals

- Solving CAPTCHAs (though a browser-agent adapter is planned for dynamic recovery)
- Replacing human judgment for legal or payment actions
- Integrating with every automation platform out of the box
- Providing a UI or SaaS layer
- Supporting every authentication pattern automatically

## Commercial alternatives

| Tool | Category | Why use Browsy instead |
|---|---|---|
| Playwright codegen | Recorder | Browsy adds safety policy, field-source mapping, dry-run, and human checkpoints |
| Selenium IDE | Recorder | Same; plus Browsy targets API-first and uses modern ESM Node |
| Stagehand / Skyvern | AI browser agent | Browsy is deterministic and auditable; use agent adapters for the dynamic portions |
| Browser Use | AI browser agent | Same; Browsy is the harness, agent is a plug-in execution layer |
| Zapier / Make | Integration platform | Browsy handles workflows that require real browser interaction or have no API |
| UiPath / Automation Anywhere | Enterprise RPA | Browsy is code-first, repo-owned, and requires no per-seat licensing |

## Adapter vision

Browsy uses an adapter interface (`adapter.discover`, `fill`, `upload`, `safeClick`, `snapshot`, `close`) so the execution engine is pluggable:

- **PlaywrightAdapter** — stable, deterministic, default
- **ApiAdapter** — for workflows with stable REST/GraphQL APIs
- **BrowserAgentAdapter** — placeholder for Stagehand, Skyvern, Browser Use, OpenClaw integration

The harness logic (field map, safety policy, manifest, logging) stays the same regardless of adapter.

## Why portable harnesses matter

Browser automation built directly against a live site in a one-off script:

- Breaks when the DOM changes
- Has no record of what it did or why it skipped something
- Cannot be reviewed before it runs against production
- Has no safety gate stopping it from clicking "Submit" or "Pay"

A Browsy harness:

- Runs in dry-run by default — no accidental actions
- Produces a detailed log every time it runs
- Stores selectors in a versioned, reviewable file
- Has an explicit safety policy that must be changed in code to relax
- Can be re-run by a coding agent, a CI job, or a developer

The goal is not to build magic. The goal is to build something that a human can trust, inspect, and hand off.
