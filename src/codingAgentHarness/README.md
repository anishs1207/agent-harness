# Coding Agent Harness

A small, inspectable coding-agent loop inspired by pi's terminal-first design. The harness owns the model conversation, workspace boundary, tools, output limits, and stopping conditions; the model decides which tools to call. It loads [`prompts/PI.md`](../../prompts/PI.md) as its persistent workflow and completion specification on every run.

## Run

```sh
npm run agent:code -- "Add a health-check endpoint and test it"
npm run agent:code -- "Fix the failing tests" ./path/to/project
```

Set `ANTHROPIC_API_KEY` in `.env`. `CODING_MODEL`, `CODING_INSTRUCTIONS`, `MAX_ITERATIONS`, and the workspace argument are optional.

## Safety and behavior

- Every file path is resolved inside the selected workspace.
- CLI writes and shell commands require approval by default; set `CODING_APPROVAL=auto` for trusted automation or `deny` for read-only runs.
- File reads, searches, and command output are capped to control context growth.
- Exact-match edits fail when the target is missing or ambiguous.
- `apply_patch` performs atomic, context-checked unified-diff edits.
- Known destructive shell commands are rejected.
- Tool errors go back to the model so it can inspect, adjust, and retry.
- Dedicated `git_status` and `git_diff` tools make existing changes and final review explicit.
- The agent stops when the model answers or the iteration guardrail fires.
- After a mutation, the harness rejects completion until a verification command, final `git_status`, and final `git_diff` all succeed.

This is intentionally educational, not a security sandbox. Run it only in a repository you trust and under an OS account with appropriately limited permissions.

## Live model evals

The cumulative eval suite creates a fresh temporary Git repository for each case, runs the real agent using `.env` credentials, and independently scores files and tests instead of trusting the model's final answer.

```sh
npm run agent:code:eval
npm run agent:code:eval -- 02-implement-from-tests
```

Cases cover repairing existing code, implementing a missing module from tests, using final Git review tools, multi-file regression work, and preserving unrelated files.
