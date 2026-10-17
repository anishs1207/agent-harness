export type Persona = {
    id: string;
    name: string;
    title: string;
    lens: string;
    instructions: string;
};

export type ConversationMessage = {
    role: "user" | "assistant";
    content: string;
};

export type PersonaReply = {
    persona: Persona;
    reply: string;
    durationMs: number;
};

export interface PersonaModelClient {
    answer(persona: Persona, messages: ConversationMessage[]): Promise<string>;
}

export type HarnessOptions = {
    personas?: Persona[];
    client?: PersonaModelClient;
    apiKey?: string;
    model?: string;
    maxTokens?: number;
};
