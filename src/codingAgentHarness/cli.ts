import dotenv from "dotenv";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { CodingAgent } from "./index.js";
import type { PermissionHandler } from "./types.js";

dotenv.config({ quiet: true });

function usage(): void {
    console.log(`Usage:
  npm run agent:code -- "<task>" [workspace]

Examples:
  npm run agent:code -- "Add input validation and tests"
  npm run agent:code -- "Explain and fix the failing build" ./packages/api

Environment:
  ANTHROPIC_API_KEY   required
  CODING_MODEL        optional; falls back to MODEL, then claude-sonnet-4-6
  CODING_INSTRUCTIONS optional Markdown instruction file; defaults to prompts/PI.md
  CODING_APPROVAL     prompt (default), auto, or deny
  MAX_ITERATIONS      optional; defaults to 30`);
}

function createCliPermissionHandler(): { handler: PermissionHandler; close(): void } {
    const mode = (process.env.CODING_APPROVAL ?? "prompt").toLowerCase();
    if (mode === "auto") return { handler: () => true, close: () => undefined };
    if (mode === "deny") return { handler: () => false, close: () => undefined };
    if (!process.stdin.isTTY) {
        return { handler: () => false, close: () => undefined };
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    return {
        handler: async (request) => {
            const answer = await readline.question(`\nApprove ${request.kind}: ${request.description}? [y/N] `);
            return /^(y|yes)$/i.test(answer.trim());
        },
        close: () => readline.close(),
    };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) return usage();
    const [task, workspaceArg] = args;
    if (!task) {
        usage();
        process.exitCode = 1;
        return;
    }
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required.");

    const workspace = path.resolve(workspaceArg ?? process.cwd());
    console.log(`Coding agent\nModel: ${process.env.CODING_MODEL ?? process.env.MODEL ?? "claude-sonnet-4-6"}\nWorkspace: ${workspace}\nTask: ${task}\n`);
    const permissions = createCliPermissionHandler();
    try {
        const agent = new CodingAgent({ workspace, maxIterations: Number(process.env.MAX_ITERATIONS ?? 30), permissionHandler: permissions.handler });
        const result = await agent.run(task);
        console.log(`\n${result.answer}\n\nStopped by: ${result.stoppedBy}; iterations: ${result.iterations}; verified: ${result.verification.passed}`);
        if (result.stoppedBy !== "model" || !result.verification.passed) process.exitCode = 2;
    } finally {
        permissions.close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
