# Python coding evaluations (Harbor)

This directory contains self-contained coding-agent tasks in the
[Harbor](https://harborframework.com/) format used by Terminal-Bench 2.0.
Each task builds an isolated codebase, gives only `instruction.md` and the
workspace to the agent, and runs the verifier after the agent exits.

## Prerequisites

- Docker
- Python 3.12+
- Harbor: `uv tool install harbor`
- `ANTHROPIC_API_KEY` when evaluating Claude Code

Use a dedicated evaluation key and keep it outside this repository. Do not add
it to `task.toml`, a Dockerfile, or `.env` committed to source control.

## Run

First prove that a task and its verifier agree by running the reference
solution:

```sh
harbor run -p ./evals/async-singleflight-cache -a oracle
```

Then run the target agent/model (the exact model identifier must be one
supported by the installed Claude Code/Harbor versions):

```sh
harbor run -p ./evals/async-singleflight-cache \
  -a claude-code \
  -m anthropic/claude-opus-4-6
```

Run several trials before calling a task a model failure:

```sh
harbor run -p ./evals/async-singleflight-cache \
  -a claude-code \
  -m anthropic/claude-opus-4-6 \
  -n 5
```

Model names change. Check `harbor run --help` and the model provider before
changing the pinned command above. A task is not labelled as defeating a model
until its job artifacts show repeatable verifier failures and the Oracle gets
full reward.

## Tasks

| Task | Focus | Network | Reward |
| --- | --- | --- | --- |
| `async-singleflight-cache` | asyncio cancellation, stale-while-revalidate, invalidation races, LRU | disabled | deterministic 0/1 |

Every task includes a `solution/solve.sh` solely for Harbor's Oracle agent. It
is not present in the normal agent workspace.
