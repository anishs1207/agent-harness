import { Workspace } from "./workspace.js";
import type { CodingTool, PermissionHandler, PermissionRequest, ToolRegistry } from "./types.js";

export const allowAllPermissions: PermissionHandler = () => true;

export function createCodingTools(workspace: Workspace, permissionHandler: PermissionHandler = allowAllPermissions): ToolRegistry {
    const permitted = async (request: PermissionRequest, action: () => Promise<string>): Promise<string> => {
        if (!await permissionHandler(request)) throw new Error(`Permission denied for ${request.tool}: ${request.description}`);
        return action();
    };
    const tools: CodingTool[] = [
        {
            definition: {
                name: "read_file",
                description: "Read a UTF-8 text file with line numbers. Reads at most 400 lines by default.",
                input_schema: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Workspace-relative file path." },
                        start_line: { type: "number" },
                        end_line: { type: "number" },
                    },
                    required: ["path"],
                },
            },
            execute: ({ path, start_line, end_line }) => workspace.readFile(String(path), Number(start_line ?? 1), end_line === undefined ? undefined : Number(end_line)),
        },
        {
            definition: {
                name: "list_files",
                description: "List workspace files recursively, excluding .git, node_modules, and dist.",
                input_schema: { type: "object", properties: { path: { type: "string" }, depth: { type: "number" } } },
            },
            execute: ({ path, depth }) => workspace.listFiles(path ? String(path) : ".", Number(depth ?? 3)),
        },
        {
            definition: {
                name: "search_files",
                description: "Search file contents with ripgrep and return matching lines.",
                input_schema: {
                    type: "object",
                    properties: { query: { type: "string" }, path: { type: "string" } },
                    required: ["query"],
                },
            },
            execute: ({ query, path }) => workspace.search(String(query), path ? String(path) : "."),
        },
        {
            definition: {
                name: "write_file",
                description: "Create or completely replace a UTF-8 file inside the workspace.",
                input_schema: {
                    type: "object",
                    properties: { path: { type: "string" }, content: { type: "string" } },
                    required: ["path", "content"],
                },
            },
            execute: ({ path, content }) => permitted(
                { kind: "write", tool: "write_file", description: `replace ${String(path)}`, input: { path, content } },
                () => workspace.writeFile(String(path), String(content)),
            ),
        },
        {
            definition: {
                name: "edit_file",
                description: "Replace one exact, unique text block in a file. Fails if it is absent or ambiguous.",
                input_schema: {
                    type: "object",
                    properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
                    required: ["path", "old_text", "new_text"],
                },
            },
            execute: ({ path, old_text, new_text }) => permitted(
                { kind: "write", tool: "edit_file", description: `edit ${String(path)}`, input: { path, old_text, new_text } },
                () => workspace.editFile(String(path), String(old_text), String(new_text)),
            ),
        },
        {
            definition: {
                name: "apply_patch",
                description: "Atomically apply unified-diff hunks to one existing file. Prefer this for precise multi-line edits. The patch may include ---/+++ headers but must use @@ hunk headers.",
                input_schema: {
                    type: "object",
                    properties: { path: { type: "string" }, patch: { type: "string" } },
                    required: ["path", "patch"],
                },
            },
            execute: ({ path, patch }) => permitted(
                { kind: "write", tool: "apply_patch", description: `patch ${String(path)}`, input: { path, patch } },
                () => workspace.applyPatch(String(path), String(patch)),
            ),
        },
        {
            definition: {
                name: "run_command",
                description: "Run a non-interactive shell command in the workspace. Use for builds, tests, formatting, git status, and focused inspection.",
                input_schema: {
                    type: "object",
                    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
                    required: ["command"],
                },
            },
            execute: ({ command, timeout_ms }) => permitted(
                { kind: "command", tool: "run_command", description: String(command), input: { command, timeout_ms } },
                () => workspace.run(String(command), Number(timeout_ms ?? 120_000)),
            ),
        },
        {
            definition: {
                name: "git_status",
                description: "Show the repository's concise working-tree status. Use before editing and during final verification.",
                input_schema: { type: "object", properties: {} },
            },
            execute: () => workspace.gitStatus(),
        },
        {
            definition: {
                name: "git_diff",
                description: "Show the repository diff. Always inspect this before declaring the task complete.",
                input_schema: {
                    type: "object",
                    properties: { staged: { type: "boolean", description: "Show staged changes instead of unstaged changes." } },
                },
            },
            execute: ({ staged }) => workspace.gitDiff(staged === true),
        },
    ];
    return { definitions: tools.map((tool) => tool.definition), byName: new Map(tools.map((tool) => [tool.definition.name, tool])) };
}
