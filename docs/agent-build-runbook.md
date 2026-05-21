# Agent Build Runbook

Use this when pointing a coding agent at Browsy.

## One-line agent prompt

```text
Read AGENTS.md first. Then read AUTOMATION_REQUEST.md. Build the completed automation harness described there under workflows/<workflow-id>/. Use APIs where available, Playwright where deterministic, and OpenClaw-style browser control only where needed. Preserve safety gates. Run npm run smoke before final response.
```

## Agent steps

1. Read `AGENTS.md`.
2. Read `AUTOMATION_REQUEST.md`.
3. Identify the workflow id.
4. Create or update `workflows/<workflow-id>/`.
5. Decide API vs Playwright vs OpenClaw/hybrid.
6. Add workflow config files.
7. Add auth/check/discovery/run commands.
8. Add safety policy.
9. Add smoke test.
10. Update workflow README.
11. Run `npm run smoke`.
12. Report exact commands for the user.

## What the agent should produce

At minimum:

```text
workflows/<workflow-id>/workflow.yaml
workflows/<workflow-id>/manifest.schema.json
workflows/<workflow-id>/manifest.example.json
workflows/<workflow-id>/safety-policy.json
workflows/<workflow-id>/field-map.example.json
workflows/<workflow-id>/field-map.local.json.example
workflows/<workflow-id>/walkthrough.md
workflows/<workflow-id>/run.mjs
workflows/<workflow-id>/smoke-test.mjs
workflows/<workflow-id>/README.md
```

## Development commands

```bash
npm install
npx playwright install chromium
npm run validate:request
npm run init:workflow -- --id my-workflow
npm run discover -- --workflow my-workflow --url https://example.com/form
npm run smoke
```

## Auth pattern

For logged-in pages:

```bash
npm run auth:save -- --workflow my-workflow --url https://example.com/login
npm run auth:check -- --workflow my-workflow --url https://example.com/form
```

Auth saving intentionally writes storage state repeatedly while the browser session is live. Do not rely only on browser close; that can race against context shutdown.

## Discovery pattern

```bash
npm run discover -- --workflow my-workflow --url https://example.com/form --pause
```

Discovery writes:

- `discovered-fields.json`
- `discovered-fields.md`
- screenshot
- page text
- HTML snapshot

## Final response format

The coding agent should return:

A. Files created/changed  
B. Setup commands  
C. Auth commands  
D. Discovery commands  
E. Dry-run command  
F. Manual checkpoints  
G. Smoke/test results  
H. Risks/assumptions
