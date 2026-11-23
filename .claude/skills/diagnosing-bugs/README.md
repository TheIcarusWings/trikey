# diagnosing-bugs (vendored)

From Matt Pocock's skills, `skills/engineering/diagnosing-bugs`:
https://github.com/mattpocock/skills at commit `abeeaf95660ba9e8b7c753eb38f441ca707a8823`.

Copied by hand and pinned, not installed as a plugin: a skill is instructions the agent follows, so every word here
is reviewed in a PR like code. To update, compare upstream at a newer commit and bring changes over in a PR.

## Changed from upstream

- **Redact** names Trikey's secrets (seeds, keys, recovery codes, nsecs, `bunker://` links, Nostr Wallet Connect
  secrets, keystores) and says never to ask for or log them, even to reproduce a bug. The same line is added where the
  skill asks the user for captured artifacts, where it adds debug logs, and in the HITL script template.
- **Feedback loops:** a short "In Trikey, try these first" list: a failing vitest test, the regtest stack
  (`npm run stack:up -w @trikey/e2e`), and the Maestro flows in apps/mobile/.maestro/regtest. Never mainnet.
- Points at DESIGN.md and docs/design/ instead of `GLOSSARY.md` and ADRs, which Trikey doesn't have.
- Left out `agents/openai.yaml` (display metadata for another agent tool; Claude Code doesn't use it).

The rest is upstream's text unchanged.

## License

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
