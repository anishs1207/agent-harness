# Browser Use Harness

The harness uses an Anthropic agent loop with Playwright-backed browser tools. Runtime source, eval fixtures, and configuration live in this repository; the eval suite does not depend on public websites.

## Run

1. Copy `.env.sample` to `.env` and set `ANTHROPIC_API_KEY` and `MODEL`.
2. Install dependencies with `npm install`.
3. Install the Playwright browser once with `npx playwright install chromium`.
4. Run a task:

```sh
npm run browser-use-harness -- "Open Hacker News and summarize the first three stories"
```

Set `HEADLESS=true` to hide the browser window. The command builds TypeScript before starting the harness.

## Cumulative browser evals

```sh
npm run browser-use-harness:eval
```

The evals run the configured model through the real agent loop in a fresh headless Playwright browser. Final DOM state is scored independently of the model's written claim. Cases are ordered by difficulty and cover observation, labelled forms, asynchronous state, validation recovery, ambiguous table actions, and dependent multi-step workflows. Keep passing cases and append harder cases to the end of `src/browserUseHarness/evals.ts`.

To rerun one failed case while iterating:

```sh
npm run browser-use-harness:eval -- 06-dependent-confirmation-workflow
```
