import type { DecisionQuestion, JevResponse } from "./types.js";

export type JevClientOptions = {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
};

export class JevClient {
    readonly model: string;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;

    constructor(options: JevClientOptions = {}) {
        const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");
        this.apiKey = apiKey;
        this.model = options.model ?? process.env.JEV_MODEL ?? "typesafe/jev-1.13";
        this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/alpha/decisions";
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    async decide(state: Record<string, unknown>, questions: Record<string, DecisionQuestion>): Promise<JevResponse> {
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await fetch(this.baseUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://github.com/local/agent-harness-pi",
                        "X-Title": "Jev Coding Permission Gate",
                    },
                    body: JSON.stringify({ model: this.model, state, questions }),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
                const body = await response.text();
                if (!response.ok) {
                    const error = new Error(`OpenRouter Decisions API ${response.status}: ${body.slice(0, 500)}`);
                    if (response.status < 500 && response.status !== 429) throw error;
                    lastError = error;
                } else {
                    const parsed = JSON.parse(body) as JevResponse;
                    if (!parsed.answers || typeof parsed.answers !== "object") throw new Error("Jev response did not contain typed answers.");
                    return parsed;
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (!/429|5\d\d|fetch failed|timeout/i.test(lastError.message)) throw lastError;
            }
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
        throw lastError ?? new Error("Jev request failed.");
    }
}
