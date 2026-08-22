import dotenv from "dotenv";
import OpenAI from "openai";
import type {
    ChatCompletionMessageParam,
    ChatCompletionFunctionTool,
} from "openai/resources/chat/completions";
import { BrowserSession } from "./browser.js";
import { createLoginHandler, type LoginHandler, type ToolEvent } from "./login-handler.js";

dotenv.config();

// ── Types ────────────────────────────────────────────────────────

export type { ToolEvent, LoginHandler };

export type GuardrailInput = {
    iterations: number;
    messages: ChatCompletionMessageParam[];
};

export type GuardrailResult = { ok: true } | { ok: false; reason: string };
export type GuardrailFn = (input: GuardrailInput) => GuardrailResult;

export type Tool = {
    definition: ChatCompletionFunctionTool;
    execute: (args: Record<string, unknown>) => Promise<string>;
};

export type ToolRegistry = {
    definitions: ChatCompletionFunctionTool[];
    byName: Map<string, Tool>;
};

export type ToolHooks = {
    onUpvoteSuccess?: (storyId: string) => void;
    onStoriesLoaded?: (stories: any[]) => void;
};

export type LoopIteration = {
    index: number;
    outcome: "tool_calls" | "answer";
    toolEvents: ToolEvent[];
    contextSize: number;
    contextTrimmed: boolean;
};

export type LoopResult = {
    answer: string;
    iterations: number;
    trace: LoopIteration[];
    stoppedBy: "model" | "guardrail" | "success";
};

export type VerifyResult = {
    passed: boolean;
    reason: string;
    fatal?: boolean;
};

export type HarnessExecutionResult = LoopResult & {
    task: string;
    model: string;
};

export type HarnessOptions = {
    verify?: (result: HarnessExecutionResult) => VerifyResult;
    maxAttempts?: number;
};

export type HarnessResult = HarnessExecutionResult & {
    attempts: number;
    verification: VerifyResult | null;
};

// ── Guardrails ───────────────────────────────────────────────────

export const maxIterations =
    (limit: number): GuardrailFn =>
        ({ iterations }) =>
            iterations >= limit
                ? { ok: false, reason: `Guardrail: reached iteration limit (${limit})` }
                : { ok: true };

export const maxMessages =
    (limit: number): GuardrailFn =>
        ({ messages }) =>
            messages.length > limit
                ? { ok: false, reason: `Guardrail: context too large (${messages.length} messages)` }
                : { ok: true };

export function combineGuardrails(...fns: GuardrailFn[]): GuardrailFn {
    return (input) => {
        for (const check of fns) {
            const result = check(input);
            if (!result.ok) return result;
        }
        return { ok: true };
    };
}

export const stopAfterUpvote =
    (getUpvotedStory: () => { id: string; title?: string; rank?: number } | null): GuardrailFn =>
        () => {
            const story = getUpvotedStory();
            if (story) {
                const storyInfo =
                    story.title && story.rank
                        ? `"${story.title}" (rank ${story.rank})`
                        : `story ID ${story.id}`;
                return { ok: false, reason: `Successfully upvoted ${storyInfo}` };
            }
            return { ok: true };
        };

export const defaultGuardrails = combineGuardrails(
    maxIterations(15),
    maxMessages(50)
);

// ── Context & Client ─────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a helpful assistant with access to tools.
Use tools whenever they help you give a more accurate answer.
When you have enough information, respond directly and concisely.
`.trim();

export function createContext(task: string): ChatCompletionMessageParam[] {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: task },
    ];
}

export function trimContext(
    messages: ChatCompletionMessageParam[],
    maxMessages: number
): ChatCompletionMessageParam[] {
    if (messages.length <= maxMessages) return messages;

    const [system, user] = messages;
    const rest = messages.slice(2);
    const trimmed = rest.slice(rest.length - (maxMessages - 2));
    return [system, user, ...trimmed];
}

const MAX_CONTEXT_MESSAGES = 20;

export const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

// ── Tools ────────────────────────────────────────────────────────

export function createTools(session: BrowserSession, hooks?: ToolHooks): ToolRegistry {
    const tools: Tool[] = [
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_navigate",
                    description: "Navigate the browser to a URL.",
                    parameters: {
                        type: "object",
                        properties: {
                            url: { type: "string" },
                        },
                        required: ["url"],
                    },
                },
            },
            execute: async ({ url }) => session.navigate(url as string),
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_url",
                    description:
                        "Get the URL of the current page. Use this to detect redirects (e.g. being sent to a login page).",
                    parameters: { type: "object", properties: {}, required: [] },
                },
            },
            execute: async () => session.getUrl(),
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_get_text",
                    description: "Get the visible text content of the current page.",
                    parameters: { type: "object", properties: {}, required: [] },
                },
            },
            execute: async () => session.getText(),
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_fill",
                    description: "Fill in an input field on the current page.",
                    parameters: {
                        type: "object",
                        properties: {
                            selector: {
                                type: "string",
                                description: 'CSS selector for the input, e.g. "input[name=\'acct\']"',
                            },
                            value: { type: "string", description: "The value to type into the field." },
                        },
                        required: ["selector", "value"],
                    },
                },
            },
            execute: async ({ selector, value }) =>
                session.fill(selector as string, value as string),
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_click",
                    description:
                        "Click an element on the current page. Also waits for any navigation that results from the click.",
                    parameters: {
                        type: "object",
                        properties: {
                            selector: { type: "string", description: 'CSS selector, e.g. "input[type=\'submit\']"' },
                        },
                        required: ["selector"],
                    },
                },
            },
            execute: async ({ selector }) => {
                const result = await session.click(selector as string);
                if (
                    hooks?.onUpvoteSuccess &&
                    /up_/.test(JSON.stringify(selector)) &&
                    /news\.ycombinator\.com\/(news)?$/.test(result)
                ) {
                    const match = (selector as string).match(/up_(\d+)/);
                    if (match) {
                        hooks.onUpvoteSuccess(match[1]);
                    }
                }
                return result;
            },
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_get_stories",
                    description:
                        "Get a structured list of Hacker News stories on the current page — rank, story ID, title, and whether you've already voted. Use this instead of browser_get_text to accurately identify which story to upvote.",
                    parameters: { type: "object", properties: {}, required: [] },
                },
            },
            execute: async () => {
                const result = await session.getStories();
                if (hooks?.onStoriesLoaded) {
                    try {
                        const stories = JSON.parse(result);
                        hooks.onStoriesLoaded(stories);
                    } catch { }
                }
                return result;
            },
        },
        {
            definition: {
                type: "function",
                function: {
                    name: "browser_has_class",
                    description:
                        "Check whether the first element matching a selector has a specific CSS class. Use this to verify upvote state: check if a[id='up_12345'] has class 'nosee' before and after clicking.",
                    parameters: {
                        type: "object",
                        properties: {
                            selector: { type: "string", description: "CSS selector for the element to check." },
                            className: { type: "string", description: "The CSS class name to look for." },
                        },
                        required: ["selector", "className"],
                    },
                },
            },
            execute: async ({ selector, className }) =>
                session.hasClass(selector as string, className as string),
        },
    ];

    return {
        definitions: tools.map((t) => t.definition),
        byName: new Map(tools.map((t) => [t.definition.function.name, t])),
    };
}

// ── Agent Loop ───────────────────────────────────────────────────

export async function runLoop(
    model: string,
    messages: ChatCompletionMessageParam[],
    guardrail: GuardrailFn,
    tools: ToolRegistry,
    loginHandler?: LoginHandler
): Promise<LoopResult> {
    const trace: LoopIteration[] = [];

    while (true) {
        const iterationIndex = trace.length + 1;

        const beforeTrim = messages.length;
        messages = trimContext(messages, MAX_CONTEXT_MESSAGES);
        const contextTrimmed = messages.length < beforeTrim;

        const check = guardrail({ iterations: trace.length, messages });
        if (!check.ok) {
            const stoppedBy = check.reason.startsWith("Successfully") ? "success" : "guardrail";
            return { answer: check.reason, iterations: trace.length, trace, stoppedBy };
        }

        // ── Model call ────────────────────────────
        process.stdout.write(`[iter ${iterationIndex}] calling model... `);
        const response = await client.chat.completions.create({
            model,
            messages,
            tools: tools.definitions,
        });

        const choice = response.choices[0];
        const contextSize = messages.length;
        console.log(`${choice.finish_reason}`);

        messages.push(choice.message as ChatCompletionMessageParam);

        // ── Final answer ──────────────────────────
        if (choice.finish_reason === "stop") {
            trace.push({ index: iterationIndex, outcome: "answer", toolEvents: [], contextSize, contextTrimmed });
            return {
                answer: choice.message.content ?? "(no response)",
                iterations: trace.length,
                trace,
                stoppedBy: "model",
            };
        }

        // ── Tool calls → execute → loop ───────────
        if (choice.finish_reason === "tool_calls") {
            const toolEvents: ToolEvent[] = [];

            for (const call of choice.message.tool_calls ?? []) {
                if (call.type !== "function") continue;
                const name = call.function.name;
                const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;

                const tool = tools.byName.get(name);
                process.stdout.write(`           → ${name}(${JSON.stringify(args)}) ... `);
                let result: string;
                try {
                    result = tool ? await tool.execute(args) : `Unknown tool: "${name}"`;
                    console.log(`done`);
                } catch (err) {
                    result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                    console.log(`error`);
                }

                toolEvents.push({ tool: name, args, result });
                messages.push({ role: "tool", tool_call_id: call.id, content: result });
            }

            if (loginHandler) {
                const loginEvent = await loginHandler();
                if (loginEvent) {
                    toolEvents.push(loginEvent);
                    messages.push({
                        role: "user",
                        content:
                            "Authentication completed by harness. You are now logged in. Navigate back to https://news.ycombinator.com and complete your upvote task.",
                    });
                }
            }

            trace.push({ index: iterationIndex, outcome: "tool_calls", toolEvents, contextSize, contextTrimmed });
        }
    }
}

// ── Harness & Verification ───────────────────────────────────────

export function verifySuccessfulUpvote(result: HarnessExecutionResult): VerifyResult {
    const events = result.trace.flatMap((iteration) => iteration.toolEvents);

    const successfulUpvote = events.find(
        (event) =>
            event.tool === "browser_click" &&
            /up_/.test(JSON.stringify(event.args)) &&
            /news\.ycombinator\.com\/(news)?$/.test(event.result.split("now at ")[1]?.trim() ?? "")
    );

    if (successfulUpvote) {
        return {
            passed: true,
            reason: `Upvote click confirmed - landed on ${successfulUpvote.result.split("now at ")[1]}`,
        };
    }

    const upvoteViaLogin = findUpvoteCompletedViaLogin(events);
    if (upvoteViaLogin) {
        return {
            passed: true,
            reason: `Upvote completed via login redirect for story ID ${upvoteViaLogin}`,
        };
    }

    const failedLogin = events.find(
        (event) =>
            event.tool === "harness_auto_login" &&
            event.result.startsWith("Harness failed to handle login at ")
    );

    if (failedLogin) {
        return {
            passed: false,
            reason: failedLogin.result,
            fatal: true,
        };
    }

    const unrecoveredLoginRedirect = events.find(
        (event) =>
            event.tool !== "harness_auto_login" &&
            isLoginUrl(extractUrl(event.result))
    );

    if (unrecoveredLoginRedirect) {
        return {
            passed: false,
            reason: `Hit login screen instead of completing the upvote (${extractUrl(unrecoveredLoginRedirect.result)})`,
            fatal: true,
        };
    }

    return {
        passed: false,
        reason: "No successful upvote click found in trace",
    };
}

function findUpvoteCompletedViaLogin(events: ToolEvent[]): string | null {
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.tool !== "browser_click") continue;
        const selector = JSON.stringify(event.args);
        const upvoteMatch = selector.match(/up_(\d+)/);
        if (!upvoteMatch) continue;
        const landedAt = event.result.split("now at ")[1]?.trim() ?? "";
        if (!/\/vote\?[^#]*\bid=\d+[^#]*\bhow=up\b/.test(landedAt)) continue;

        const followedByLogin = events.slice(i + 1).some(
            (next) =>
                next.tool === "harness_auto_login" &&
                next.result.startsWith("Harness automatically handled login at ")
        );
        if (followedByLogin) return upvoteMatch[1];
    }
    return null;
}

function extractUrl(result: string): string | null {
    const match = result.match(/https?:\/\/\S+/);
    return match ? match[0] : null;
}

function isLoginUrl(url: string | null): boolean {
    return !!url && (url.includes("/login") || url.includes("/vote"));
}

async function runHarnessAttempt(
    task: string,
    model: string
): Promise<HarnessExecutionResult> {
    const session = new BrowserSession();
    let upvotedStory: { id: string; title?: string; rank?: number } | null = null;
    let storiesData: any[] = [];

    await session.open();

    try {
        const recordUpvoteSuccess = (storyId: string, source: "click" | "login") => {
            const story = storiesData.find((s) => s.id === storyId);
            upvotedStory = story
                ? { id: storyId, title: story.title, rank: story.rank }
                : { id: storyId };
            const via = source === "login" ? " via login redirect" : "";
            console.log(`\n[harness] Upvote successful${via} for story ID ${storyId} - forcing completion\n`);
        };

        const tools = createTools(session, {
            onUpvoteSuccess: (storyId) => recordUpvoteSuccess(storyId, "click"),
            onStoriesLoaded: (stories) => {
                storiesData = stories;
            },
        });

        const guardrails = combineGuardrails(
            stopAfterUpvote(() => upvotedStory),
            defaultGuardrails
        );

        const messages = createContext(task);
        const loginHandler = createLoginHandler(session, {
            onUpvoteSuccess: (storyId) => recordUpvoteSuccess(storyId, "login"),
        });
        const result = await runLoop(model, messages, guardrails, tools, loginHandler);
        return { task, model, ...result };
    } finally {
        await session.close();
    }
}

export async function runHarness(
    task: string,
    model: string,
    options: HarnessOptions = {}
): Promise<HarnessResult> {
    const maxAttempts = options.maxAttempts ?? 1;
    let latestResult: HarnessResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await runHarnessAttempt(task, model);
        const verification = options.verify ? options.verify(result) : null;
        const answer =
            verification && !verification.passed
                ? verification.reason
                : result.answer;

        latestResult = { ...result, answer, attempts: attempt, verification };

        if (!verification || verification.passed || verification.fatal || attempt === maxAttempts) {
            return latestResult;
        }

        console.log(`\nAttempt ${attempt} failed - retrying (${attempt + 1}/${maxAttempts})...\n`);
    }

    throw new Error("Harness finished without producing a result");
}

export function printHarnessResult(result: HarnessResult): void {
    console.log("\n--- Agent trace ---\n");

    for (const iteration of result.trace) {
        const trimNote = iteration.contextTrimmed ? " (trimmed)" : "";
        const ctx = `[ctx: ${iteration.contextSize}${trimNote}]`;

        if (iteration.outcome === "tool_calls") {
            console.log(`[iter ${iteration.index}] ${iteration.toolEvents.length} tool call(s) ${ctx}`);
            for (const event of iteration.toolEvents) {
                console.log(`  -> ${event.tool}(${JSON.stringify(event.args)})`);
                console.log(`     ${event.result.slice(0, 120)}${event.result.length > 120 ? "..." : ""}`);
            }
        } else {
            console.log(`[iter ${iteration.index}] answered ${ctx}`);
        }

        console.log();
    }

    console.log("--- Result ---\n");
    console.log(result.answer);
    console.log(`\nStopped by: ${result.stoppedBy} after ${result.iterations} iteration(s)`);
    console.log(`Attempts:   ${result.attempts}`);

    if (result.verification) {
        const status = result.verification.passed ? "PASS" : "FAIL";
        console.log(`Verify:     ${status} - ${result.verification.reason}`);
    }
}

// ── Runner ───────────────────────────────────────────────────────

const MODEL = process.env.MODEL || "openai/gpt-3.5-turbo-0613";

const TASK = `
    Upvote a story on Hacker News.

    Go to https://news.ycombinator.com.
    Call browser_get_stories to see ranked stories with their IDs and voted status.
    Find the highest-ranked story where alreadyVoted is false.
    Click its upvote arrow using the exact selector: a[id="up_STORYID"] (replace STORYID with the actual id).
`.trim();

async function main() {
    console.log(`Model: ${MODEL}`);
    console.log(`Task:  upvote on Hacker News\n`);

    const result = await runHarness(TASK, MODEL, {
        verify: verifySuccessfulUpvote,
        maxAttempts: 3,
    });
    printHarnessResult(result);

}

main();