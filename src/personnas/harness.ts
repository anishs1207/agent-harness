import { AnthropicPersonaClient } from "./client.js";
import { PERSONAS } from "./personas.js";
import type { ConversationMessage, HarnessOptions, Persona, PersonaModelClient, PersonaReply } from "./types.js";

export class ProductPersonaHarness {
    readonly personas: Persona[];
    private readonly client: PersonaModelClient;
    private readonly histories = new Map<string, ConversationMessage[]>();

    constructor(options: HarnessOptions = {}) {
        this.personas = options.personas?.length ? [...options.personas] : [...PERSONAS];
        const ids = new Set<string>();
        for (const persona of this.personas) {
            if (ids.has(persona.id)) throw new Error(`Duplicate persona id: ${persona.id}`);
            ids.add(persona.id);
            this.histories.set(persona.id, []);
        }
        this.client = options.client ?? new AnthropicPersonaClient(options);
    }

    async ask(question: string): Promise<PersonaReply[]> {
        const trimmed = question.trim();
        if (!trimmed) throw new Error("Question cannot be empty.");

        return Promise.all(this.personas.map(async (persona) => {
            const history = this.histories.get(persona.id)!;
            const messages: ConversationMessage[] = [...history, { role: "user", content: trimmed }];
            const started = Date.now();
            const reply = await this.client.answer(persona, messages);
            history.push({ role: "user", content: trimmed }, { role: "assistant", content: reply });
            return { persona, reply, durationMs: Date.now() - started };
        }));
    }

    reset(): void {
        for (const history of this.histories.values()) history.length = 0;
    }
}
