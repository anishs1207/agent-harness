// ─────────────────────────────────────────────
// PART 1: The dataset
// ─────────────────────────────────────────────

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export type TestCase = {
    id: string;
    input: string;
    expected: string; // the correct answer
    trap?: string; // the wrong answer most models give
    tags?: string[];
};

export const dataset: TestCase[] = [
    {
        id: "geo-australia-capital",
        input: "What is the capital of Australia?",
        expected: "Canberra",
        trap: "Sydney",
        tags: ["geography"],
    },
    {
        id: "geo-brazil-capital",
        input: "What is the capital of Brazil?",
        expected: "Brasília",
        trap: "Rio de Janeiro",
        tags: ["geography"],
    },
    {
        id: "geo-most-lakes",
        input: "Which country has the most natural lakes in the world?",
        expected: "Canada",
        trap: "Russia",
        tags: ["geography"],
    },
    {
        id: "bio-octopus-hearts",
        input: "How many hearts does an octopus have?",
        expected: "3",
        trap: "1",
        tags: ["biology"],
    },
    {
        id: "bio-spider-legs",
        input: "How many legs does a spider have?",
        expected: "8",
        trap: "6",
        tags: ["biology"],
    },
    {
        id: "astro-mars-moons",
        input: "How many moons does Mars have?",
        expected: "2",
        trap: "1",
        tags: ["astronomy"],
    },
    {
        id: "geo-populous-2024",
        input: "What is the most populous country in the world as of 2024?",
        expected: "India",
        trap: "China",
        tags: ["geography", "recency"],
    },
    {
        id: "sci-salt-boiling",
        input: "Does adding salt to water raise or lower its boiling point?",
        expected: "raise",
        trap: "lower",
        tags: ["science"],
    },
];

// ─────────────────────────────────────────────
// PART 2: The model
// ─────────────────────────────────────────────

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

export async function callModel(
    model: string,
    prompt: string
): Promise<string> {
    const response = await client.chat.completions.create({
        model,
        max_tokens: 64,
        messages: [
            {
                role: "system",
                content:
                    "Answer as briefly as possible. One word or number if you can. No punctuation.",
            },
            { role: "user", content: prompt },
        ],
    });

    return response.choices[0].message.content?.trim() ?? "";
}

// ─────────────────────────────────────────────
// PART 3: The scorers
// ─────────────────────────────────────────────

export type ScorerFn = (actual: string, expected: string) => number;

const NUMBER_WORDS: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
};

function normalize(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(
            /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
            (word) => NUMBER_WORDS[word]!
        );
}

export function scoreExactMatch(actual: string, expected: string): number {
    return normalize(actual) === normalize(expected) ? 1 : 0;
}

export function scoreContains(actual: string, expected: string): number {
    return normalize(actual).includes(normalize(expected)) ? 1 : 0;
}

export function scoreKeywords(actual: string, keywords: string[]): number {
    if (keywords.length === 0) return 0;
    const text = normalize(actual);
    const hits = keywords.filter((k) => text.includes(normalize(k))).length;
    return hits / keywords.length;
}

// ─────────────────────────────────────────────
// PART 4: The runner
// ─────────────────────────────────────────────

export type RunResult = {
    id: string;
    expected: string;
    actual: string;
    trap: string | undefined;
    felForTrap: boolean;
    score: number;
    passed: boolean;
    latencyMs: number;
};

export type EvalRun = {
    model: string;
    results: RunResult[];
    passed: number;
    total: number;
    avgScore: number;
    avgLatencyMs: number;
};

export async function runEval(
    cases: TestCase[],
    model: string,
    scorer: ScorerFn
): Promise<EvalRun> {
    const results: RunResult[] = [];

    for (const testCase of cases) {
        const start = Date.now();
        const actual = await callModel(model, testCase.input);
        const latencyMs = Date.now() - start;
        const score = scorer(actual, testCase.expected);

        const felForTrap =
            testCase.trap !== undefined &&
            actual.toLowerCase().includes(testCase.trap.toLowerCase());

        results.push({
            id: testCase.id,
            expected: testCase.expected,
            actual,
            trap: testCase.trap,
            felForTrap,
            score,
            passed: score >= 1,
            latencyMs,
        });
    }

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / total;
    const avgLatencyMs = results.reduce((sum, r) => sum + r.latencyMs, 0) / total;

    return { model, results, passed, total, avgScore, avgLatencyMs };
}

// ─────────────────────────────────────────────
// PART 5: The output
// ─────────────────────────────────────────────

export function printRun(run: EvalRun): void {
    console.log(`\n=== ${run.model} ===\n`);
    console.table(
        run.results.map((r) => ({
            id: r.id,
            passed: r.passed ? "✓" : "✗",
            felForTrap: r.felForTrap ? "🪤" : "",
            expected: r.expected,
            actual: r.actual,
            latencyMs: r.latencyMs,
        }))
    );
}

export function printComparison(runs: EvalRun[]): void {
    console.log("\n=== COMPARISON ===\n");
    console.table(
        runs.map((run) => ({
            model: run.model,
            passed: `${run.passed} / ${run.total}`,
            traps: run.results.filter((r) => r.felForTrap).length,
            avgScore: run.avgScore.toFixed(2),
            avgLatencyMs: run.avgLatencyMs.toFixed(0),
        }))
    );
}
