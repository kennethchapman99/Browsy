# observation-realistic-upload fixture

A single-page multi-stage release-upload fixture used for Browsy observation
hardening tests and manual realism checks.

Serve it via the wizard at:

```
http://localhost:3333/fixtures/observation-realistic-upload/release.html
```

## What it represents

A realistic distribution-SaaS upload workflow, condensed into three in-page
stages (no network calls — submits are intercepted):

1. **Metadata.** Required text inputs (title, artist, release date), required
   email, optional genre select, required cover-art file input.
2. **Tracks.** A dynamic repeated group — "+ Add another track" creates a new
   row containing a text title, an ISRC field, and a required audio file
   input. Includes a checklist of confirmations, two of which are required
   ("I confirm rights", "I agree to terms"). One optional ("explicit content").
3. **Review &amp; Publish.** Shows a derived review pane, then exposes a
   `Submit & Publish Release` button — the dangerous-action candidate the
   observation pipeline should flag.

## Why it exists

The original `observation-test-form` is intentionally minimal so the core
Playwright acceptance check stays fast. That fixture exercises every event
type, but it doesn't *look* like a real SaaS workflow.

This fixture is closer to what real users will point Browsy at:

- Required-field semantics — multiple `required` inputs of mixed types.
- Real upload affordances — both image and audio file inputs.
- An actual repeated group with delete handling and stable ID prefixes
  (`track_title_<n>`, `track_isrc_<n>`, `track_audio_<n>`).
- A multi-stage flow inside a single HTML document — observation has to handle
  visible/hidden stages without losing field context.
- A clearly-named dangerous action.
- Optional vs required confirmations — useful for testing whether the pipeline
  picks up the asymmetry.

It is *not* a substitute for testing on a real SaaS site (shadow DOM, popups,
real auth, CAPTCHA, custom widgets). See
[docs/observation-hardening-report.md](../../docs/observation-hardening-report.md)
for what this still doesn't prove.
