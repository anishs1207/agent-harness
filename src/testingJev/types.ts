export type ChoiceQuestion = {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
};

export type NoulQuestion = {
    type: "noul";
    instructions: string;
    criteria: { true: string; false: string };
};

export type ScoreQuestion = {
    type: "score";
    instructions: string;
    criteria: string[];
};

export type DecisionQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type ChoiceAnswer = {
    type: "choice";
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
};

export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = {
    type: "score";
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
    legend: Record<string, string>;
};

export type DecisionAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type JevResponse = {
    id: string;
    model: string;
    provider: string;
    answers: Record<string, DecisionAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
};

export type PermissionAction = {
    userRequest: string;
    tool: string;
    arguments: Record<string, unknown>;
};

export type PermissionDecision = "allow" | "review" | "block";

export type PermissionAssessment = {
    decision: PermissionDecision;
    modelChoice: PermissionDecision;
    confidence: number;
    reversibleProbability: number;
    riskScore: number;
    model: string;
    cost?: number;
};
