import dotenv from "dotenv";
import { createInterface } from "node:readline/promises";
import { ProductPersonaHarness } from "./harness.js";
import { PERSONAS, findPersonas } from "./personas.js";
import type { PersonaReply } from "./types.js";

dotenv.config({ quiet: true });

function usage(): void {
    console.log(`Product Persona Harness

Usage:
  npm run agent:personas
  npm run agent:personas -- "Should we add a free trial?"
  npm run agent:personas -- --personas strategist,engineer "Should we build this?"

Options:
  -p, --personas <ids>  Comma-separated persona IDs (default: all)
  -l, --list            List available personas
  -h, --help            Show help

Interactive commands: /help, /personas, /reset, /quit

Environment:
  ANTHROPIC_API_KEY  required
  PERSONA_MODEL      optional; falls back to MODEL, then claude-sonnet-4-6`);
}

function parseArgs(args: string[]): { question?: string; personaIds: string[]; list: boolean; help: boolean } {
    const positionals: string[] = [];
    let personaIds: string[] = [];
    let list = false;
    let help = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--help" || arg === "-h") help = true;
        else if (arg === "--list" || arg === "-l") list = true;
        else if (arg === "--personas" || arg === "-p") {
            const value = args[++index];
            if (!value) throw new Error(`${arg} requires a comma-separated value.`);
            personaIds = value.split(",").map((id) => id.trim()).filter(Boolean);
        } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        else positionals.push(arg);
    }
    return { question: positionals.join(" ").trim() || undefined, personaIds, list, help };
}

function listPersonas(): void {
    for (const persona of PERSONAS) console.log(`${persona.id.padEnd(11)} ${persona.name} — ${persona.title}: ${persona.lens}`);
}

function printReplies(replies: PersonaReply[]): void {
    for (const { persona, reply, durationMs } of replies) {
        console.log(`\n━━ ${persona.name} · ${persona.title} (${durationMs}ms) ━━\n`);
        console.log(reply);
    }
    console.log();
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) return usage();
    if (parsed.list) return listPersonas();
    const personas = findPersonas(parsed.personaIds);
    const harness = new ProductPersonaHarness({ personas });

    console.log(`Product Persona Panel: ${personas.map((p) => p.name).join(", ")}`);
    if (parsed.question) {
        printReplies(await harness.ask(parsed.question));
        return;
    }
    if (!process.stdin.isTTY) throw new Error("Provide a question when running without an interactive terminal.");

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Ask a product question, or type /help.");
    try {
        while (true) {
            const input = (await readline.question("\nproduct> ")).trim();
            if (!input) continue;
            if (["/quit", "/exit", "quit", "exit"].includes(input.toLowerCase())) break;
            if (input === "/help") { console.log("Commands: /personas lists the panel, /reset clears conversation context, /quit exits."); continue; }
            if (input === "/personas") { listPersonas(); continue; }
            if (input === "/reset") { harness.reset(); console.log("Conversation context cleared."); continue; }
            try { printReplies(await harness.ask(input)); }
            catch (error) { console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
    } finally {
        readline.close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
