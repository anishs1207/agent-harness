import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type Page } from "playwright";

dotenv.config();

// ── Types ────────────────────────────────────────────────────────

export type Coordinate = {
    x: number;
    y: number;
};

export type ComputerAction =
    | { action: "key"; text: string }
    | { action: "type"; text: string }
    | { action: "mouse_move"; coordinate: [number, number] }
    | { action: "left_click" }
    | { action: "left_click_coordinate"; coordinate: [number, number] }
    | { action: "right_click" }
    | { action: "double_click" }
    | { action: "triple_click" }
    | { action: "middle_click" }
    | { action: "drag"; coordinate: [number, number] }
    | { action: "mouse_down" }
    | { action: "mouse_up" }
    | { action: "scroll"; coordinate?: [number, number]; delta_x?: number; delta_y?: number }
    | { action: "screenshot" }
    | { action: "cursor_position" }
    | { action: "wait"; duration?: number };

export interface ComputerEnvironment {
    readonly width: number;
    readonly height: number;
    open(initialUrl?: string): Promise<void>;
    screenshot(): Promise<string>; // Returns base64 encoded PNG
    execute(action: ComputerAction): Promise<string | { output?: string; error?: string }>;
    close(): Promise<void>;
}

export type AgentStepTrace = {
    step: number;
    actions: ComputerAction[];
    modelThoughts?: string;
    screenshotBase64?: string;
    toolOutputs: string[];
};

export type RunResult = {
    success: boolean;
    finalAnswer: string;
    steps: number;
    trace: AgentStepTrace[];
    error?: string;
};

// ── Playwright Computer Environment ──────────────────────────────

export class PlaywrightComputerEnvironment implements ComputerEnvironment {
    public readonly width: number;
    public readonly height: number;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private cursor: Coordinate = { x: 0, y: 0 };
    private headless: boolean;

    constructor(options?: { width?: number; height?: number; headless?: boolean }) {
        this.width = options?.width ?? 1024;
        this.height = options?.height ?? 768;
        this.headless = options?.headless ?? false;
    }

    async open(initialUrl: string = "https://news.ycombinator.com"): Promise<void> {
        this.browser = await chromium.launch({
            headless: this.headless,
            args: [`--window-size=${this.width},${this.height}`],
        });
        const context = await this.browser.newContext({
            viewport: { width: this.width, height: this.height },
            deviceScaleFactor: 1,
        });
        this.page = await context.newPage();
        await this.page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        this.cursor = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
    }

    async screenshot(): Promise<string> {
        if (!this.page) throw new Error("Browser environment not opened");
        const buffer = await this.page.screenshot({ type: "png" });
        return buffer.toString("base64");
    }

    async execute(action: ComputerAction): Promise<string> {
        if (!this.page) throw new Error("Browser environment not opened");

        switch (action.action) {
            case "screenshot": {
                return "Screenshot captured successfully.";
            }

            case "mouse_move": {
                const [x, y] = action.coordinate;
                this.cursor = { x, y };
                await this.page.mouse.move(x, y);
                return `Moved mouse to (${x}, ${y})`;
            }

            case "left_click": {
                await this.page.mouse.click(this.cursor.x, this.cursor.y, { button: "left" });
                await this.page.waitForTimeout(500);
                return `Left clicked at (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "left_click_coordinate": {
                const [x, y] = action.coordinate;
                this.cursor = { x, y };
                await this.page.mouse.click(x, y, { button: "left" });
                await this.page.waitForTimeout(500);
                return `Left clicked at (${x}, ${y})`;
            }

            case "right_click": {
                await this.page.mouse.click(this.cursor.x, this.cursor.y, { button: "right" });
                return `Right clicked at (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "double_click": {
                await this.page.mouse.dblclick(this.cursor.x, this.cursor.y);
                return `Double clicked at (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "triple_click": {
                await this.page.mouse.click(this.cursor.x, this.cursor.y, { clickCount: 3 });
                return `Triple clicked at (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "middle_click": {
                await this.page.mouse.click(this.cursor.x, this.cursor.y, { button: "middle" });
                return `Middle clicked at (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "mouse_down": {
                await this.page.mouse.down();
                return "Mouse down";
            }

            case "mouse_up": {
                await this.page.mouse.up();
                return "Mouse up";
            }

            case "drag": {
                const [x, y] = action.coordinate;
                await this.page.mouse.down();
                await this.page.mouse.move(x, y, { steps: 5 });
                await this.page.mouse.up();
                this.cursor = { x, y };
                return `Dragged to (${x}, ${y})`;
            }

            case "type": {
                await this.page.keyboard.type(action.text, { delay: 50 });
                return `Typed text: "${action.text}"`;
            }

            case "key": {
                // Map common keys if needed
                const key = action.text;
                await this.page.keyboard.press(key);
                return `Pressed key: "${key}"`;
            }

            case "scroll": {
                const deltaX = action.delta_x ?? 0;
                const deltaY = action.delta_y ?? (action.coordinate ? action.coordinate[1] : 100);
                await this.page.mouse.wheel(deltaX, deltaY);
                return `Scrolled (${deltaX}, ${deltaY})`;
            }

            case "cursor_position": {
                return `Current cursor position is (${this.cursor.x}, ${this.cursor.y})`;
            }

            case "wait": {
                const duration = action.duration ?? 1000;
                await this.page.waitForTimeout(duration);
                return `Waited for ${duration}ms`;
            }

            default: {
                return `Unknown action: ${JSON.stringify(action)}`;
            }
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

// ── Computer Use Agent ────────────────────────────────────────────

export interface ComputerAgentOptions {
    anthropicApiKey?: string;
    model?: string;
    maxSteps?: number;
    environment?: ComputerEnvironment;
}

export class ComputerUseAgent {
    private client: Anthropic;
    private model: string;
    private maxSteps: number;
    private env: ComputerEnvironment;

    constructor(options?: ComputerAgentOptions) {
        this.client = new Anthropic({
            apiKey: options?.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
        });
        const rawModel = options?.model ?? process.env.MODEL;
        this.model = (rawModel && !rawModel.includes("4-6")) ? rawModel : "claude-3-7-sonnet-20250219";
        this.maxSteps = options?.maxSteps ?? 20;
        this.env = options?.environment ?? new PlaywrightComputerEnvironment();
    }

    /**
     * Runs the Computer Use agent on an instruction or goal.
     */
    async run(instruction: string, initialUrl?: string): Promise<RunResult> {
        const trace: AgentStepTrace[] = [];

        console.log(`\n🚀 [ComputerUseAgent] Starting task: "${instruction}"`);
        await this.env.open(initialUrl);

        try {
            // Initialize conversation history
            const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `You are an AI computer use agent controlling a machine.\nYour display resolution is ${this.env.width}x${this.env.height}.\n\nGoal: ${instruction}\n\nCarefully inspect the screen screenshot before each action. Click coordinates must match the UI elements on the screen.`,
                        },
                    ],
                },
            ];

            let step = 0;
            let finalAnswer = "";

            while (step < this.maxSteps) {
                step++;
                console.log(`\n── Step ${step}/${this.maxSteps} ──`);

                // 1. Capture current screenshot
                const screenshotBase64 = await this.env.screenshot();

                // 2. Call Claude with Computer Use beta tool
                const response = await this.client.beta.messages.create({
                    model: this.model,
                    max_tokens: 2048,
                    betas: ["computer-use-2024-10-22"],
                    tools: [
                        {
                            type: "computer_20241022",
                            name: "computer",
                            display_width_px: this.env.width,
                            display_height_px: this.env.height,
                        },
                    ],
                    messages: [
                        ...messages,
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image",
                                    source: {
                                        type: "base64",
                                        media_type: "image/png",
                                        data: screenshotBase64,
                                    },
                                },
                            ],
                        },
                    ],
                });

                // Extract text thoughts & tool calls
                let thoughts = "";
                const toolUses: Anthropic.Beta.Messages.BetaToolUseBlock[] = [];

                for (const block of response.content) {
                    if (block.type === "text") {
                        thoughts += block.text + "\n";
                    } else if (block.type === "tool_use") {
                        toolUses.push(block);
                    }
                }

                if (thoughts.trim()) {
                    console.log(`🧠 [Model Thought]:\n${thoughts.trim()}`);
                }

                // If no tool is used, the agent considers the task done or has answered
                if (toolUses.length === 0) {
                    finalAnswer = thoughts.trim();
                    console.log(`✅ [Task Completed] Final Answer:\n${finalAnswer}`);
                    return {
                        success: true,
                        finalAnswer,
                        steps: step,
                        trace,
                    };
                }

                // Execute each tool action
                const toolResults: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
                const executedActions: ComputerAction[] = [];
                const toolOutputs: string[] = [];

                for (const toolUse of toolUses) {
                    const actionInput = toolUse.input as ComputerAction;
                    console.log(`⚡ [Executing Action]: ${JSON.stringify(actionInput)}`);

                    try {
                        const output = await this.env.execute(actionInput);
                        const outputStr = typeof output === "string" ? output : (output.output ?? "Action completed");
                        toolOutputs.push(outputStr);
                        executedActions.push(actionInput);

                        // If the action was taking a screenshot or needs updated visual feedback
                        const postScreenshot = await this.env.screenshot();

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: [
                                { type: "text", text: outputStr },
                                {
                                    type: "image",
                                    source: {
                                        type: "base64",
                                        media_type: "image/png",
                                        data: postScreenshot,
                                    },
                                },
                            ],
                        });
                    } catch (err: any) {
                        const errMessage = err.message || String(err);
                        console.error(`❌ [Action Error]: ${errMessage}`);
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            is_error: true,
                            content: [{ type: "text", text: `Error: ${errMessage}` }],
                        });
                    }
                }

                // Append assistant response and tool results to messages
                messages.push({
                    role: "assistant",
                    content: response.content,
                });

                messages.push({
                    role: "user",
                    content: toolResults,
                });

                trace.push({
                    step,
                    actions: executedActions,
                    modelThoughts: thoughts.trim(),
                    screenshotBase64,
                    toolOutputs,
                });
            }

            return {
                success: false,
                finalAnswer: "Max steps reached without completion.",
                steps: step,
                trace,
            };
        } catch (error: any) {
            console.error("❌ Agent error:", error);
            return {
                success: false,
                finalAnswer: "",
                steps: trace.length,
                trace,
                error: error.message || String(error),
            };
        } finally {
            await this.env.close();
        }
    }
}

// ── Standalone CLI Demo ──────────────────────────────────────────

export const COMPUTER_BENCHMARK_TASKS = [
    {
        id: "hn-visual-browse",
        title: "Hacker News: Visual Inspection",
        task: "Look up the top story on Hacker News and print its title.",
        url: "https://news.ycombinator.com",
    },
    {
        id: "calculator-calc",
        title: "Web Calculator: Visual Buttons",
        task: "Navigate to an online calculator (https://www.desmos.com/scientific), click the buttons to calculate 128 * 4 + 12, and report the displayed answer.",
        url: "https://www.desmos.com/scientific",
    },
    {
        id: "drawing-canvas",
        title: "Canvas: Freehand Drawing",
        task: "Navigate to an interactive canvas or whiteboard (https://excalidraw.com), locate the drawing tool, draw a rectangle using mouse drag, and report completion.",
        url: "https://excalidraw.com",
    },
    {
        id: "slider-control",
        title: "Slider: Coordinate Drag",
        task: "Navigate to https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/range, locate the slider widget, and drag the slider handle towards the right.",
        url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/range",
    },
];

async function main() {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  npm run agent:computer -- "[task description]" [optional initial url]

Examples:
  npm run agent:computer -- "Find the highest voted post on Hacker News"
  npm run agent:computer -- "Click the search bar, type 'Claude' and press Enter" https://en.wikipedia.org

Benchmark Tasks Available:
${COMPUTER_BENCHMARK_TASKS.map((t, i) => `  ${i + 1}. [${t.id}] ${t.title}\n     Task: ${t.task}`).join("\n\n")}
`);
        return;
    }

    let task: string;
    let initialUrl: string;

    if (args.length > 0) {
        task = args[0];
        initialUrl = args[1] || "https://news.ycombinator.com";
    } else {
        const defaultBenchmark = COMPUTER_BENCHMARK_TASKS[0];
        console.log(`\nNo custom task provided. Running default benchmark task: "${defaultBenchmark.title}"`);
        console.log(`To run a custom task, use: npm run agent:computer -- "Your task description here"\n`);
        task = defaultBenchmark.task;
        initialUrl = defaultBenchmark.url;
    }

    const agent = new ComputerUseAgent();
    const result = await agent.run(task, initialUrl);
    console.log("\n── Run Summary ──");
    console.log(`Success: ${result.success}`);
    console.log(`Steps taken: ${result.steps}`);
    if (result.finalAnswer) {
        console.log(`Result: ${result.finalAnswer}`);
    }
}

// Execute if run directly
const isDirectRun = Boolean(
    process.argv[1] && (
        process.argv[1].includes("computerUseAgent") ||
        process.argv[1].includes("computer-use")
    )
);

if (isDirectRun) {
    main().catch((err) => {
        console.error("Computer Use Agent error:", err);
        process.exit(1);
    });
}
