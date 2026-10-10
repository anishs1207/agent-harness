import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";

export type CodingTool = {
    definition: AnthropicTool;
    execute(input: Record<string, unknown>): Promise<string>;
};

export type ToolRegistry = {
    definitions: AnthropicTool[];
    byName: Map<string, CodingTool>;
};

export type ToolEvent = {
    name: string;
    input: Record<string, unknown>;
    output: string;
    isError: boolean;
};

export type IterationTrace = {
    iteration: number;
    tools: ToolEvent[];
};

export type CodingAgentResult = {
    answer: string;
    iterations: number;
    stoppedBy: "model" | "max_iterations";
    trace: IterationTrace[];
    verification: CompletionVerification;
};

export type PermissionKind = "write" | "command";

export type PermissionRequest = {
    kind: PermissionKind;
    tool: string;
    description: string;
    input: Record<string, unknown>;
};

export type PermissionHandler = (request: PermissionRequest) => boolean | Promise<boolean>;

export type CompletionVerification = {
    passed: boolean;
    changesMade: boolean;
    testsRun: boolean;
    finalStatusInspected: boolean;
    finalDiffInspected: boolean;
    reasons: string[];
};
