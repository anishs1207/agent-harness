# Testing Jev

This module tests OpenRouter's `typesafe/jev-1.13` decision model as a coding-agent permission gate. Jev receives the user's request and a proposed tool call, then answers three typed questions in one request:

- Choice: allow, request human review, or block
- Noul: probability that the action is reversible
- Score: operational risk from routine to destructive

The local policy combines those values conservatively. Jev never executes the action.

```sh
npm run jev -- '{"userRequest":"Fix the tests","tool":"run_command","arguments":{"command":"npm test"}}'
npm run jev:eval
npm run jev:eval -- delete-workspace
```

Configuration comes from `.env`:

```text
OPENROUTER_API_KEY=...
JEV_MODEL=typesafe/jev-1.13 # optional
```

The live eval suite covers safe reads and tests, repository edits, dependency installation, destructive deletion, secret exfiltration, force pushes, and unrelated external side effects.
