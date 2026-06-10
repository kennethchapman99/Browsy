#!/usr/bin/env node
// Acceptance: generic auth-preflight rule evaluation.
//
// Browsy owns the browser; the app (e.g. Pancake Robot) owns which URLs/text mean
// "not authenticated" for a workflow. This proves the generic evaluator classifies
// observed page facts (final URL, title, body text) against app-provided rules —
// authenticated targets pass, Google-rejected / signin / login states return
// auth_required, and no cookies/tokens are involved (it is a pure evaluator).

import assert from 'node:assert/strict';
import { DEFAULT_AUTH_PREFLIGHT_RULES, evaluateAuthPreflight } from '../src/core/auth-preflight.mjs';

function pass(msg) { console.log(`PASS ${msg}`); }

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; pass(label); };

try {
  // 1. Authenticated target URL passes.
  check('authenticated DistroKid upload page passes preflight', () => {
    const verdict = evaluateAuthPreflight({
      targetUrl: 'https://distrokid.com/new/',
      finalUrl: 'https://distrokid.com/new/',
      title: 'Upload your music - DistroKid',
      bodyText: 'Upload a new release. Album title, artwork, tracks…',
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 'authenticated');
    assert.equal(verdict.matchedRule, null);
  });

  // 2. Google rejected OAuth ("this browser or app may not be secure") → auth_required.
  check('Google "browser may not be secure" rejection returns auth_required', () => {
    const verdict = evaluateAuthPreflight({
      targetUrl: 'https://distrokid.com/new/',
      finalUrl: 'https://accounts.google.com/v3/signin/rejected',
      title: "Couldn't sign you in",
      bodyText: 'This browser or app may not be secure. Try using a different browser.',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'auth_required');
    assert.match(verdict.message, /rejected|automation browser/i);
  });

  // 3. A bare /signin or /login redirect returns auth_required.
  check('redirect to a /signin URL returns auth_required', () => {
    const verdict = evaluateAuthPreflight({
      targetUrl: 'https://distrokid.com/new/',
      finalUrl: 'https://distrokid.com/signin?next=/new/',
      title: 'Sign in',
      bodyText: 'Please sign in to continue.',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'auth_required');
    assert.equal(verdict.matchedRule.value, '/signin');
  });

  // 4. App-provided rules override the defaults (keeps Browsy generic).
  check('app-provided custom rules are honored over defaults', () => {
    const rules = [{ code: 'auth_required', when: 'textIncludes', value: 'please log in to acme' }];
    const verdict = evaluateAuthPreflight({
      targetUrl: 'https://acme.example/app',
      finalUrl: 'https://acme.example/app',
      title: 'ACME',
      bodyText: 'Please log in to ACME to continue.',
      rules,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.matchedRule.value, 'please log in to acme');
  });

  // 5. Defaults exist and are frozen so callers cannot mutate shared rule state.
  check('default rules are present and immutable', () => {
    assert.ok(DEFAULT_AUTH_PREFLIGHT_RULES.length >= 4);
    assert.equal(Object.isFrozen(DEFAULT_AUTH_PREFLIGHT_RULES), true);
  });

  console.log(`Auth preflight acceptance: ${passed} passed, 0 failed`);
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
}
