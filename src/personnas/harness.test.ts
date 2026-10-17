import assert from "node:assert/strict";
import test from "node:test";
import { ProductPersonaHarness } from "./harness.js";
import { PERSONAS, findPersonas } from "./personas.js";
import type { ConversationMessage, Persona, PersonaModelClient } from "./types.js";

class FakeClient implements PersonaModelClient {
    calls: Array<{ persona: Persona; messages: ConversationMessage[] }> = [];
    async answer(persona: Persona, messages: ConversationMessage[]): Promise<string> {
        this.calls.push({ persona, messages });
        return `${persona.id}: ${messages.at(-1)?.content}`;
    }
}

test("asks every persona and preserves declared order", async () => {
    const client = new FakeClient();
    const harness = new ProductPersonaHarness({ client });
    const replies = await harness.ask("Should we launch?");
    assert.equal(replies.length, 5);
    assert.deepEqual(replies.map((item) => item.persona.id), PERSONAS.map((item) => item.id));
    assert.equal(client.calls.length, 5);
});

test("keeps isolated conversation history for follow-up questions", async () => {
    const client = new FakeClient();
    const harness = new ProductPersonaHarness({ client, personas: findPersonas(["strategist", "engineer"]) });
    await harness.ask("First question");
    await harness.ask("Follow-up");
    const followUps = client.calls.slice(2);
    assert.equal(followUps.length, 2);
    for (const call of followUps) {
        assert.deepEqual(call.messages.map((message) => message.role), ["user", "assistant", "user"]);
        assert.equal(call.messages[0].content, "First question");
        assert.match(call.messages[1].content, new RegExp(`^${call.persona.id}:`));
    }
});

test("reset clears history and empty questions are rejected", async () => {
    const client = new FakeClient();
    const harness = new ProductPersonaHarness({ client, personas: findPersonas(["designer"]) });
    await harness.ask("Initial");
    harness.reset();
    await harness.ask("Fresh");
    assert.equal(client.calls.at(-1)?.messages.length, 1);
    await assert.rejects(() => harness.ask("   "), /cannot be empty/);
});

test("rejects unknown persona IDs", () => {
    assert.throws(() => findPersonas(["not-real"]), /Unknown persona/);
});
