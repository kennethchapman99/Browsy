# Browsy

Browser automation harness factory.

Browsy is designed so a coding agent can read **one filled-in request file** and produce a completed, safe, inspectable automation harness using the best available mix of:

- APIs
- Playwright
- OpenClaw-style browser control
- saved browser sessions
- human checkpoints

The goal is not to create a magical autonomous browser agent. The goal is to generate boring, reviewable automation that can be tested, logged, and stopped before risky actions.

## Core workflow

1. Fill in `automation.request.md`.
2. Point a coding agent at this repo.
3. Tell it: `Read AGENTS.md and build the automation described in automation.request.md.`
4. The coding agent should output a completed workflow under `workflows/<workflow-id>/`.
5. You test using dry-run commands before allowing any real-world action.

## Key files

| File | Purpose |
|---|---|
| `automation.request.md` | The single file you fill in for a new workflow. |
| `AGENTS.md` | The coding-agent instruction contract. |
| `docs/agent-build-runbook.md` | Step-by-step agent build process. |
| `docs/architecture.md` | System design and safety philosophy. |
| `templates/workflow/` | Reference structure agents should copy from. |
| `src/core/` | Reusable auth, discovery, runtime, and safety primitives. |
| `examples/distrokid-upload/` | Reference example based on the Pancake Robot DistroKid case. |

## Install

```bash
npm install
npx playwright install chromium
```

## Validate the request file

```bash
npm run validate:request
```

## Create a new workflow skeleton

```bash
npm run init:workflow -- --id my-workflow
```

## Discover a page DOM

```bash
npm run discover -- --workflow my-workflow --url https://example.com/form
```

## Save auth for a workflow

```bash
npm run auth:save -- --workflow my-workflow --url https://example.com/login
npm run auth:check -- --workflow my-workflow --url https://example.com/form
```

## Smoke test

```bash
npm run smoke
```

## Safety defaults

Browsy-generated automations should default to:

- dry-run mode
- visible browser mode
- screenshots and logs
- explicit safety policies
- no final submit/payment/purchase actions
- no paid extras or legal checkboxes unless manually approved

## Coding-agent handoff

Use this prompt with Claude Code, Codex, or similar:

```text
You are working in the Browsy repo. Read AGENTS.md first. Then read automation.request.md. Build the completed automation harness described there under workflows/<workflow-id>/. Use APIs where available, Playwright where deterministic, and OpenClaw-style browser control only where needed. Preserve all safety gates. Run npm run smoke before final response.
```
