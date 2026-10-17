# Product Persona Harness

A CLI panel that asks five independent product personas the same question in parallel. In interactive mode, each persona remembers its own conversation so follow-up questions retain context without mixing voices.

## Personas

- `strategist` — product and market direction
- `researcher` — user needs and evidence
- `designer` — workflows and usability
- `engineer` — feasibility and delivery risk
- `growth` — adoption, retention, and metrics

## Run

Set `ANTHROPIC_API_KEY` in `.env`, then run:

```sh
npm run agent:personas
npm run agent:personas -- "Should we offer a 14-day free trial?"
npm run agent:personas -- --personas strategist,engineer "Should this be native or a web app?"
```

Use `--list` to inspect the panel. Interactive mode supports `/personas`, `/reset`, and `/quit`.

## Library API

```ts
import { ProductPersonaHarness } from "./personnas/index.js";

const panel = new ProductPersonaHarness();
const replies = await panel.ask("What is the riskiest assumption in this idea?");
```

Pass a custom `PersonaModelClient` to test or connect another model provider.
