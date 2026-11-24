#!/usr/bin/env node
// Does this PR say what could break? Every PR fills in the "What could break" section of
// .github/PULL_REQUEST_TEMPLATE.md with one line: none / low / high, and why (CLAUDE.md). This reads the PR's text from
// the PR_BODY environment variable (never from the command line, so no shell ever sees it) and checks that the
// section exists and that its first line, once the template's <!-- --> hint is removed, starts with None, Low or High
// followed by a reason:
//
//   None: docs only, no app or guardian code.
//   **Low** - changes the send screen's wording, not what is signed.
//   High: changes the guardian's spending limit check.
//
// Exits 0 when it does, 1 when it does not (with a ::error line saying what is missing). Used by
// .github/workflows/pr-text.yml; tested by e2e/test/unit/what-could-break.test.ts.

import { pathToFileURL } from 'node:url';

/** @returns {string | null} the problem, or null when the section is filled in. */
export function whatCouldBreakProblem(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s+what could break\s*$/i.test(l.trim()));
  if (start < 0) return 'The PR text has no "## What could break" section (see .github/PULL_REQUEST_TEMPLATE.md).';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3}\s/.test(l.trim()));
  const first = (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).find((l) => l !== '');
  if (!first) return '"What could break" is empty: write one line, none / low / high, and why.';
  const m = /^(?:[-*]\s+)?(?:\*\*|__)?(none|low|high)(?:\*\*|__)?\b\s*[:.,;—–-]?\s*(.*)$/i.exec(first);
  if (!m) return `"What could break" must start with None, Low or High, not: ${first.slice(0, 80)}`;
  if (m[2].replace(/[^\p{L}\p{N}]/gu, '').length < 3) return `"What could break" says ${m[1]} but not why.`;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = whatCouldBreakProblem(process.env.PR_BODY);
  if (problem) {
    console.log(`::error title=What could break::${problem}`);
    process.exit(1);
  }
  console.log('"What could break" is filled in.');
}
