import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { promises as fs } from "node:fs";
import path from "node:path";
import { allowAllPermissions, createCodingTools } from "./tools.js";
import type { CodingAgentResult, CompletionVerification, IterationTrace, PermissionHandler, ToolEvent } from "./types.js";
import { Workspace } from "./workspace.js";

export { Workspace } from "./workspace.js";
export { createCodingTools } from "./tools.js";
export type * from "./types.js";

const SYSTEM_PROMPT = `You are a capable coding agent working in a scoped repository.
Inspect relevant files before editing. Preserve existing conventions and user changes.
Use workspace-relative paths. Make focused edits, then run the most relevant checks.
Never claim that a change works without examining tool output. If a tool fails, diagnose and recover.
Do not expose secrets, access paths outside the workspace, or run destructive commands.
Before finishing, inspect git status and the final diff. When finished, summarize what changed and the verification performed.`;

export type CodingAgentOptions = {
    apiKey?: string;
    model?: string;
    workspace?: string;
    maxIterations?: number;
    maxContextMessages?: number;
    maxTokens?: number;
    instructionsPath?: string;
    client?: Anthropic;
    onEvent?: (message: string) => void;
    permissionHandler?: PermissionHandler;
};

export class CodingAgent {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly workspace: Workspace;
    private readonly maxIterations: number;
    private readonly maxContextMessages: number;
    private readonly maxTokens: number;
    private readonly instructionsPath: string;
    private readonly onEvent: (message: string) => void;
    private readonly permissionHandler: PermissionHandler;

    constructor(options: CodingAgentOptions = {}) {
        this.client = options.client ?? new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
        this.model = options.model ?? process.env.CODING_MODEL ?? process.env.MODEL ?? "claude-sonnet-4-6";
        this.workspace = new Workspace(options.workspace);
        this.maxIterations = options.maxIterations ?? 30;
        this.maxContextMessages = options.maxContextMessages ?? 40;
        this.maxTokens = options.maxTokens ?? 4096;
        this.instructionsPath = path.resolve(options.instructionsPath ?? process.env.CODING_INSTRUCTIONS ?? path.join(process.cwd(), "prompts", "PI.md"));
        this.onEvent = options.onEvent ?? ((message) => console.log(message));
        this.permissionHandler = options.permissionHandler ?? allowAllPermissions;
    }

    async run(task: string): Promise<CodingAgentResult> {
        const tools = createCodingTools(this.workspace, this.permissionHandler);
        const markdownInstructions = await this.loadInstructions();
        let messages: MessageParam[] = [{ role: "user", content: task }];
        const trace: IterationTrace[] = [];

        for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
            messages = trimContext(messages, this.maxContextMessages);
            this.onEvent(`[${iteration}/${this.maxIterations}] calling ${this.model}`);
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: this.maxTokens,
                system: `${SYSTEM_PROMPT}\n\nThe following repository-provided Markdown is the persistent workflow and completion specification. Follow it where it does not conflict with the safety rules above.\n\n${markdownInstructions}\n\nWorkspace root: ${this.workspace.root}`,
                messages,
                tools: tools.definitions,
            });
            messages.push({ role: "assistant", content: response.content });

            const calls = response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
            if (calls.length === 0) {
                const answer = response.content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
                const verification = verifyCompletion(trace);
                if (!verification.passed) {
                    this.onEvent(`  completion rejected: ${verification.reasons.join("; ")}`);
                    messages.push({ role: "user", content: `The harness cannot accept completion yet: ${verification.reasons.join("; ")}. Continue working, perform the missing verification, then answer again.` });
                    continue;
                }
                return { answer: answer || "(no response)", iterations: iteration, stoppedBy: "model", trace, verification };
            }

            const events: IterationTrace["tools"] = [];
            const results: ToolResultBlockParam[] = [];
            for (const call of calls) {
                const input = call.input as Record<string, unknown>;
                this.onEvent(`  -> ${call.name}(${compact(input)})`);
                let output: string;
                let isError = false;
                try {
                    const tool = tools.byName.get(call.name);
                    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
                    output = await tool.execute(input);
                } catch (error) {
                    isError = true;
                    output = `Error: ${error instanceof Error ? error.message : String(error)}`;
                }
                events.push({ name: call.name, input, output, isError });
                results.push({ type: "tool_result", tool_use_id: call.id, content: output, is_error: isError });
            }
            trace.push({ iteration, tools: events });
            messages.push({ role: "user", content: results });
        }

        return { answer: `Stopped after ${this.maxIterations} iterations.`, iterations: this.maxIterations, stoppedBy: "max_iterations", trace, verification: verifyCompletion(trace) };
    }

    private async loadInstructions(): Promise<string> {
        try {
            return await fs.readFile(this.instructionsPath, "utf8");
        } catch (error: any) {
            if (error.code === "ENOENT") return "No external instruction file was found; use the built-in coding workflow.";
            throw new Error(`Could not load coding instructions from ${this.instructionsPath}: ${error.message}`);
        }
    }
}

const MUTATION_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

export function verifyCompletion(trace: IterationTrace[]): CompletionVerification {
    const events = trace.flatMap((turn) => turn.tools);
    const lastMutation = findLastIndex(events, (event) => MUTATION_TOOLS.has(event.name) && !event.isError);
    const changesMade = lastMutation >= 0;
    if (!changesMade) return { passed: true, changesMade: false, testsRun: false, finalStatusInspected: false, finalDiffInspected: false, reasons: [] };
    const afterChanges = events.slice(lastMutation + 1);
    const testsRun = afterChanges.some((event) => event.name === "run_command" && !event.isError && isVerificationCommand(String(event.input.command ?? "")));
    const finalStatusInspected = afterChanges.some((event) => event.name === "git_status" && !event.isError);
    const finalDiffInspected = afterChanges.some((event) => event.name === "git_diff" && !event.isError);
    const reasons: string[] = [];
    if (!testsRun) reasons.push("run a relevant test, build, lint, or type-check command after the final edit");
    if (!finalStatusInspected) reasons.push("inspect git_status after the final edit");
    if (!finalDiffInspected) reasons.push("inspect git_diff after the final edit");
    return { passed: reasons.length === 0, changesMade, testsRun, finalStatusInspected, finalDiffInspected, reasons };
}

function findLastIndex(events: ToolEvent[], predicate: (event: ToolEvent) => boolean): number {
    for (let index = events.length - 1; index >= 0; index--) if (predicate(events[index])) return index;
    return -1;
}

function isVerificationCommand(command: string): boolean {
    return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)(?::[\w-]+)?\b/i.test(command)
        || /\bnode\s+--test\b/i.test(command)
        || /\b(?:tsc|pytest|vitest|jest)\b/i.test(command)
        || /\b(?:cargo|go)\s+test\b/i.test(command);
}

export function trimContext(messages: MessageParam[], limit: number): MessageParam[] {
    if (messages.length <= limit) return messages;
    const first = messages[0];
    const pairCount = Math.max(0, Math.floor((limit - 1) / 2));
    return [first, ...messages.slice(-(pairCount * 2))];
}

function compact(input: Record<string, unknown>): string {
    const value = JSON.stringify(input);
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
