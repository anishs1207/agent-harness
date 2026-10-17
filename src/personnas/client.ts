import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ConversationMessage, Persona, PersonaModelClient } from "./types.js";

export class AnthropicPersonaClient implements PersonaModelClient {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly maxTokens: number;

    constructor(options: { apiKey?: string; model?: string; maxTokens?: number } = {}) {
        const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required.");
        this.client = new Anthropic({ apiKey });
        this.model = options.model ?? process.env.PERSONA_MODEL ?? process.env.MODEL ?? "claude-sonnet-4-6";
        this.maxTokens = options.maxTokens ?? 1200;
    }

    async answer(persona: Persona, messages: ConversationMessage[]): Promise<string> {
        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: this.maxTokens,
            system: `You are ${persona.name}, a ${persona.title} on a product review panel. Your lens is: ${persona.lens}.\n\n${persona.instructions}\n\nAnswer independently in your own voice. Be candid, specific, and concise. Start with your verdict, explain the most important reasoning and tradeoffs, then give 2-4 actionable recommendations. Ask at most one clarifying question, only when it would materially change your advice. Never claim access to facts or research that were not provided.`,
            messages: messages as MessageParam[],
        });
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
        if (!text) throw new Error(`${persona.name} returned an empty response.`);
        return text;
    }
}
