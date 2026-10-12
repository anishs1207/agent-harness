# Async single-flight cache

This hard Python repair task evaluates whether an agent can reason about
interacting `asyncio` invariants in a small, realistic package. The complete
contract is in [`instruction.md`](instruction.md).

## Environment

- `python:3.12-slim-bookworm`
- standard library only
- 2 CPUs, 2 GiB RAM, 4 GiB storage
- no network access
- 30-minute agent timeout

The starter code includes two public tests. Harbor uploads the more extensive
verifier tests only after the agent run.

## Verification

`tests/test.sh` runs public and hidden `unittest` suites and writes a binary
reward to `/logs/verifier/reward.txt`. The suite covers duration validation,
stale latency, refresh coalescing, cancellation shielding, invalidate/clear
linearization, failure handling, LRU behavior, zero-capacity coalescing, and
cross-key concurrency.

## Layout

```text
async-singleflight-cache/
├── task.toml                 Harbor resources and metadata
├── instruction.md            prompt shown to the coding agent
├── environment/              starter Python package and public tests
├── tests/                    hidden deterministic verifier
└── solution/                 Oracle-only reference implementation
```

## Run

```sh
harbor run -p ./evals/async-singleflight-cache -a oracle
harbor run -p ./evals/async-singleflight-cache -a claude-code -m anthropic/claude-opus-4-6
```

Always require a full Oracle reward before interpreting agent failures.
