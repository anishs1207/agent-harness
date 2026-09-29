import dotenv from "dotenv";
import { BrowserSession } from "./index.js";
import { createTools, runLoop, defaultGuardrails, createContext, printHarnessResult, type HarnessResult } from "../index.js";

dotenv.config();

export const BROWSER_BENCHMARK_TASKS = [
    {
        id: "hn-top-stories",
        title: "Hacker News: Top 3 Stories & Points",
        task: "Navigate to https://news.ycombinator.com, read the top 3 stories and their point scores, and print a formatted summary.",
        url: "https://news.ycombinator.com",
    },
    {
        id: "wiki-search",
        title: "Wikipedia: Search & Section Extraction",
        task: "Navigate to https://en.wikipedia.org, search for 'Artificial intelligence', and extract the first 3 subheadings from the Table of Contents.",
        url: "https://en.wikipedia.org",
    },
    {
        id: "todomvc-test",
        title: "TodoMVC: Interactive State Verification",
        task: "Navigate to https://todomvc.com/examples/react/dist/, add two tasks: 'Buy groceries' and 'Read documentation', mark 'Buy groceries' as completed, and verify the remaining item count.",
        url: "https://todomvc.com/examples/react/dist/",
    },
    {
        id: "books-scrape",
        title: "Books to Scrape: Catalog Pagination",
        task: "Navigate to http://books.toscrape.com, find the first book rated with 5 stars on page 1, and return its title and price.",
        url: "http://books.toscrape.com",
    },
];

export async function runBrowserAgent(taskDescription: string, initialUrl?: string): Promise<HarnessResult> {
    const model = process.env.MODEL || "claude-sonnet-4-6";

    console.log("\n=======================================================");
    console.log("🌐 Browser Use Agent (DOM & Semantic Automation)");
    console.log("=======================================================");
    console.log(`Model: ${model}`);
    console.log(`Task:  ${taskDescription}`);
    if (initialUrl) console.log(`Start: ${initialUrl}`);
    console.log("=======================================================\n");

    const session = new BrowserSession();
    await session.open({ headless: process.env.HEADLESS === "true" });

    try {
        if (initialUrl) {
            await session.navigate(initialUrl);
        }

        const tools = createTools(session);
        const messages = createContext(taskDescription);

        const loopResult = await runLoop(model, messages, defaultGuardrails, tools);
        const result: HarnessResult = {
            ...loopResult,
            task: taskDescription,
            model,
            attempts: 1,
            verification: null,
        };

        printHarnessResult(result);
        return result;
    } finally {
        await session.close();
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  npm run browser-use-harness -- "[task description]" [optional initial url]

Examples:
  npm run browser-use-harness -- "Navigate to Wikipedia and summarize Quantum Computing"
  npm run browser-use-harness -- "Find the top story on Hacker News" https://news.ycombinator.com

Benchmark Tasks Available:
${BROWSER_BENCHMARK_TASKS.map((t, i) => `  ${i + 1}. [${t.id}] ${t.title}\n     Task: ${t.task}`).join("\n\n")}
`);
        return;
    }

    let task: string;
    let initialUrl: string | undefined;

    if (args.length > 0) {
        task = args[0];
        initialUrl = args[1];
    } else {
        // Default benchmark task
        const defaultBenchmark = BROWSER_BENCHMARK_TASKS[0];
        console.log(`\nNo custom task provided. Running default benchmark task: "${defaultBenchmark.title}"`);
        console.log(`To run a custom task, use: npm run browser-use-harness -- "Your task description here"\n`);
        task = defaultBenchmark.task;
        initialUrl = defaultBenchmark.url;
    }

    await runBrowserAgent(task, initialUrl);
}

const isDirectRun = Boolean(
    process.argv[1] && (
        process.argv[1].includes("browserUseHarness") ||
        process.argv[1].includes("cli")
    )
);

if (isDirectRun) {
    main().catch((err) => {
        console.error("Agent execution error:", err);
        process.exit(1);
    });
}
