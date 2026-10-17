# Agent Harness Playground

An inspectable collection of agent harnesses, safety experiments, observability infrastructure, and coding evaluations. These projects demonstrate that useful agents need more than a model: they need tools, context, permissions, verification, traces, and managed environments.

## Projects at a glance

| Project | Purpose | Stack | Run |
| --- | --- | --- | --- |
| [Product Persona Harness](#product-persona-harness) | Review product questions from five perspectives | TypeScript, Anthropic | `npm run agent:personas` |
| [Coding Agent Harness](#coding-agent-harness) | Inspect, edit, and verify a scoped repository | TypeScript, Anthropic | `npm run agent:code` |
| [Browser Use Harness](#browser-use-harness) | Automate websites with semantic DOM tools | TypeScript, Anthropic, Playwright | `npm run agent:browser` |
| [Computer Use Harness](#computer-use-harness) | Operate a browser with screenshots and coordinates | TypeScript, Anthropic Computer Use, Playwright | `npm run agent:computer` |
| [Jev Permission Gate](#jev-permission-gate) | Classify proposed actions before execution | TypeScript, OpenRouter | `npm run jev` |
| [Observable Production Agent](#observable-production-agent) | Serve a stateful, traced agent over HTTP | Python, FastAPI, LangGraph | `python observability/main.py` |
| [Harbor Coding Evaluations](#harbor-coding-evaluations) | Evaluate coding agents in isolated tasks | Python, Docker, Harbor | `harbor run ...` |

## Shared setup

The TypeScript projects require Node.js and npm. Browser projects also require Chromium.

```sh
npm install
npx playwright install chromium
npm run build
```

Copy `.env.sample` to `.env`, then configure the providers needed by the project you want to run:

```dotenv
ANTHROPIC_API_KEY=your_anthropic_api_key_here
MODEL=claude-sonnet-4-6
PERSONA_MODEL=claude-sonnet-4-6
CODING_MODEL=claude-sonnet-4-6
OPENROUTER_API_KEY=your_openrouter_api_key_here
JEV_MODEL=typesafe/jev-1.13
HEADLESS=true
```

## Product Persona Harness

Ask five product specialists the same question in parallel. Each responds independently and keeps private conversation history, allowing contextual follow-ups without blending voices.

| ID | Persona | Role | Focus |
| --- | --- | --- | --- |
| `strategist` | Maya | Product Strategist | Market, positioning, and product direction |
| `researcher` | Leo | User Researcher | User needs, behavior, and evidence |
| `designer` | Priya | Product Designer | Experience, workflows, and usability |
| `engineer` | Noah | Staff Engineer | Feasibility, architecture, and delivery risk |
| `growth` | Zara | Growth & Metrics Lead | Adoption, retention, and measurable outcomes |

Features include concurrent attributed responses, isolated persona memory, interactive and one-shot modes, persona filtering, resettable context, an injectable model client, and a reusable TypeScript API.

```sh
npm run agent:personas
npm run agent:personas -- "Should we offer a 14-day free trial?"
npm run agent:personas -- --personas strategist,engineer "Native app or web app?"
npm run agent:personas -- --list
```

Interactive commands are `/personas`, `/reset`, `/help`, and `/quit`.

```ts
import { ProductPersonaHarness } from "./personnas/index.js";

const panel = new ProductPersonaHarness();
const replies = await panel.ask("What is the riskiest assumption?");
```

Test with `npm run test:personas`. The tests inject a fake client and require no API key. See [`src/personnas/README.md`](src/personnas/README.md).

## Coding Agent Harness

A terminal-first coding loop that gives an Anthropic model a controlled workspace and focused repository tools. The harness owns context, permissions, output limits, iteration limits, and completion verification.

Features:

- Workspace-bound paths with traversal protection
- Reads, search, directory listing, exact edits, writes, and unified patches
- Shell commands with `auto`, `prompt`, or `deny` approval policies
- Rejection of known destructive commands
- Bounded command output and conversation context
- Tool-error feedback so the model can recover
- Dedicated Git status and diff tools
- Mandatory verification, status, and diff checks after mutations
- Live evals scored from files and tests rather than the final model claim

```sh
npm run agent:code -- "Fix the failing tests"
npm run agent:code -- "Add a health-check endpoint and tests" ./path/to/project
npm run test:code
npm run agent:code:eval
npm run agent:code:eval -- 02-implement-from-tests
```

Configuration includes `CODING_MODEL`, `CODING_APPROVAL`, `CODING_INSTRUCTIONS`, and `MAX_ITERATIONS`. See [`src/codingAgentHarness/README.md`](src/codingAgentHarness/README.md).

## Browser Use Harness

A semantic browser agent that controls an isolated Playwright session through structured DOM tools instead of screen coordinates.

Features:

- Navigation, page text, title, and structured story extraction
- Selector-based clicks, typing, key presses, scrolling, and selects
- Time and selector waits, screenshots, and constrained evaluation
- Attribute and class inspection for state verification
- Context trimming plus iteration and message guardrails
- Per-run browser lifecycle with guaranteed cleanup
- Optional Hacker News login handling
- Iteration, context-size, and tool-call traces
- Cumulative evals for forms, async state, recovery, tables, and multi-step flows

```sh
npm run agent:browser -- "Find the top story on Hacker News" https://news.ycombinator.com
npm run browser-use-harness -- "Search Wikipedia for artificial intelligence"
npm run browser-use-harness:eval
npm run browser-use-harness:eval -- 06-dependent-confirmation-workflow
```

The CLI includes example tasks for Hacker News, Wikipedia, TodoMVC, and Books to Scrape. Set `HEADLESS=true` for background execution.

## Computer Use Harness

An experimental visual agent built on Anthropic's Computer Use beta. It captures the screen, lets the model choose mouse or keyboard actions, executes them in Playwright, and returns a fresh screenshot.

Features:

- Screenshot-driven visual reasoning
- Mouse movement, coordinate clicks, multi-clicks, and dragging
- Keyboard input, scrolling, waiting, and cursor inspection
- Configurable viewport, model, environment, and step limit
- Step traces containing actions, model text, screenshots, and outputs
- Injectable `ComputerEnvironment`
- Benchmark ideas for news, calculators, drawing canvases, and sliders

```sh
npm run agent:computer -- "Find the highest-voted post on Hacker News"
npm run agent:computer -- "Search for Claude" https://en.wikipedia.org
```

This is a visual browser environment, not unrestricted native desktop control.

## Jev Permission Gate

A typed safety layer that sends the user request and proposed tool call to OpenRouter's Jev decision model, then applies a conservative local policy. Jev makes a decision but never executes the action.

It returns `allow`, `review`, or `block`, estimates reversibility, scores operational risk, and retries transient failures. Live evals cover safe reads, tests, edits, installations, destructive deletion, secret access, force pushes, and unrelated external side effects.

```sh
npm run jev -- '{"userRequest":"Fix the tests","tool":"run_command","arguments":{"command":"npm test"}}'
npm run jev:eval
npm run jev:eval -- delete-workspace
```

Requires `OPENROUTER_API_KEY`. See [`src/testingJev/README.md`](src/testingJev/README.md).

## Observable Production Agent

A separate Python service showing how to operate a tool-using agent with durable conversations, authentication, health checks, and optional tracing.

Features include a FastAPI service and CLI, a LangGraph loop with SQLite thread memory, OpenRouter model access through LangChain, bearer authentication, optional LangSmith and Langfuse tracing, graceful trace flushing, and a token-free `/healthz` endpoint.

```powershell
cd observability
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.sample .env
python main.py
```

Run a one-off task with `python main.py "Multiply 6 by 7"`. Reuse `thread_id` in HTTP requests to continue a conversation. See [`observability/README.md`](observability/README.md).

## Harbor Coding Evaluations

Self-contained tasks in the Harbor format used by Terminal-Bench 2.0. Each task builds an isolated codebase, exposes only its instruction and workspace to the agent, and runs an independent verifier afterward.

Features include Docker isolation, deterministic rewards, an Oracle reference solution, network-disabled execution, public and hidden tests, and repeated model trials. The current `async-singleflight-cache` task covers asyncio cancellation, stale-while-revalidate, invalidation races, and LRU behavior.

Requirements: Docker, Python 3.12+, Harbor, and credentials for the evaluated agent.

```sh
harbor run -p ./evals/async-singleflight-cache -a oracle
harbor run -p ./evals/async-singleflight-cache -a claude-code -m anthropic/claude-opus-4-6
harbor run -p ./evals/async-singleflight-cache -a claude-code -m anthropic/claude-opus-4-6 -n 5
```

See [`evals/README.md`](evals/README.md).

## Command reference

| Command | Description |
| --- | --- |
| `npm run build` | Compile all TypeScript sources |
| `npm run agent:personas` | Start the product persona panel |
| `npm run test:personas` | Run offline persona tests |
| `npm run agent:code` | Run the workspace coding agent |
| `npm run test:code` | Run coding workspace tests |
| `npm run agent:code:eval` | Run live coding-agent evals |
| `npm run agent:browser` | Run the semantic browser agent |
| `npm run browser-use-harness:eval` | Run browser evals |
| `npm run agent:computer` | Run the visual Computer Use agent |
| `npm run jev` | Assess a proposed action |
| `npm run jev:eval` | Run permission-policy evals |

## Repository layout

```text
src/
  personnas/             Product review panel and CLI
  codingAgentHarness/    Coding loop, workspace tools, tests, and evals
  browserUseHarness/     Playwright environment and browser evals
  computerUseHarness/    Screenshot-and-coordinate agent
  testingJev/            Permission gate and evals
observability/           Python production-agent service
evals/                   Harbor/Terminal-Bench coding tasks
docs/                    Notes and supporting project material
```

## Safety

- Keep API keys local and never commit them.
- The coding harness has guardrails but is not an OS security sandbox.
- Prefer prompt-based approvals unless you trust the task and workspace.
- Automate only websites and accounts where you have permission.
- Use dedicated credentials and isolated environments for evaluations.
