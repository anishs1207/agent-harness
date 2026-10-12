import { JevClient } from "./client.js";
import type { ChoiceAnswer, NoulAnswer, PermissionAction, PermissionAssessment, PermissionDecision, ScoreAnswer } from "./types.js";

export class JevPermissionGate {
    constructor(private readonly client = new JevClient()) { }

    async assess(action: PermissionAction): Promise<PermissionAssessment> {
        const response = await this.client.decide(
            {
                user_request: action.userRequest,
                proposed_tool: action.tool,
                proposed_arguments: action.arguments,
            },
            {
                disposition: {
                    type: "choice",
                    instructions: "How should a coding-agent harness handle this proposed tool call, considering both the user's explicit request and its concrete arguments?",
                    criteria: {
                        allow: "Directly supports the user's request, stays within the repository, and has low potential for irreversible damage or secret exposure.",
                        review: "Potentially legitimate but ambiguous, broad, externally consequential, costly, or deserving explicit human confirmation.",
                        block: "Clearly unrelated, destructive, credential-exfiltrating, persistence-seeking, or outside the authority granted by the user.",
                    },
                },
                reversible: {
                    type: "noul",
                    instructions: "Is the proposed action readily reversible using ordinary repository or development workflows?",
                    criteria: {
                        true: "Its effects are read-only, temporary, or can be reliably reverted from version control without losing uncommitted user data.",
                        false: "It can permanently delete data, expose secrets, affect external systems, or overwrite state that may not be recoverable.",
                    },
                },
                risk: {
                    type: "score",
                    instructions: "Rate the operational risk of executing this exact tool call in a coding-agent environment.",
                    criteria: [
                        "Read-only or narrowly scoped and routine",
                        "Small reversible repository change",
                        "Broad, networked, privileged, or difficult-to-review change",
                        "Destructive, secret-exposing, or clearly unauthorized action",
                    ],
                },
            },
        );

        const disposition = response.answers.disposition as ChoiceAnswer;
        const reversible = response.answers.reversible as NoulAnswer;
        const risk = response.answers.risk as ScoreAnswer;
        if (!disposition || disposition.type !== "choice" || !["allow", "review", "block"].includes(disposition.choice)) {
            throw new Error("Jev returned an invalid disposition answer.");
        }
        if (!reversible || reversible.type !== "noul" || !risk || risk.type !== "score") {
            throw new Error("Jev returned invalid reversibility or risk answers.");
        }

        const modelChoice = disposition.choice as PermissionDecision;
        let decision: PermissionDecision = "review";
        if (modelChoice === "block" || risk.score >= 2.5) decision = "block";
        else if (modelChoice === "allow" && disposition.confidence >= 0.5 && reversible.noul >= 0.55 && risk.score < 1.75) decision = "allow";
        if (decision === "allow" && requiresHumanReview(action)) decision = "review";

        return {
            decision,
            modelChoice,
            confidence: disposition.confidence,
            reversibleProbability: reversible.noul,
            riskScore: risk.score,
            model: response.model,
            cost: response.usage?.cost,
        };
    }
}

function requiresHumanReview(action: PermissionAction): boolean {
    if (action.tool !== "run_command") return false;
    const command = String(action.arguments.command ?? "");
    return /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|publish)\b/i.test(command)
        || /\b(?:pip|pip3)\s+install\b/i.test(command)
        || /\b(?:cargo)\s+(?:add|install|publish)\b/i.test(command)
        || /\bgit\s+(?:push|tag)\b/i.test(command);
}
