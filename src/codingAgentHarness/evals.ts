import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodingAgent, type CodingAgentResult } from "./index.js";

dotenv.config({ quiet: true });
const execFileAsync = promisify(execFile);

type Fixture = Record<string, string>;
type CodingEval = {
    level: number;
    id: string;
    description: string;
    task: string;
    fixture: Fixture;
    verify(root: string, result: CodingAgentResult): Promise<string>;
};

type EvalResult = {
    id: string;
    level: number;
    passed: boolean;
    durationMs: number;
    iterations: number;
    toolsUsed: string[];
    evidence?: string;
    error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function runNodeTests(root: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--test"], { cwd: root, timeout: 30_000 });
    return `${stdout}${stderr}`;
}

export const codingEvals: CodingEval[] = [
    {
        level: 1,
        id: "01-fix-existing-code",
        description: "Inspect, repair, and verify a localized defect",
        task: "Fix the implementation so all tests pass. Inspect the repository first, make the smallest appropriate change, run the tests, and review the final diff.",
        fixture: {
            "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2),
            "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n",
            "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds positive and negative numbers', () => { assert.equal(add(7, 5), 12); assert.equal(add(-2, 5), 3); });\n",
        },
        verify: async (root, result) => {
            const source = await fs.readFile(path.join(root, "src/math.js"), "utf8");
            assert(/return\s+a\s*\+\s*b/.test(source), "addition implementation was not repaired");
            assert(result.trace.some((turn) => turn.tools.some((tool) => tool.name === "read_file")), "agent did not inspect a file");
            assert(result.trace.some((turn) => turn.tools.some((tool) => tool.name === "run_command")), "agent did not run verification");
            await runNodeTests(root);
            return "independent node:test passed and source contains addition";
        },
    },
    {
        level: 2,
        id: "02-implement-from-tests",
        description: "Create a missing module from behavioral tests",
        task: "Implement the missing slugify module described by the tests. Follow existing module conventions, run the tests, and inspect git status and the final diff before finishing.",
        fixture: {
            "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2),
            "test/slugify.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('normalizes titles', () => { assert.equal(slugify('  Hello, World!  '), 'hello-world'); });\ntest('collapses separators', () => { assert.equal(slugify('one___two   three'), 'one-two-three'); });\ntest('removes edge separators', () => { assert.equal(slugify('--Ship It--'), 'ship-it'); });\n",
            "src/example.js": "export function identity(value) {\n  return value;\n}\n",
        },
        verify: async (root, result) => {
            const source = await fs.readFile(path.join(root, "src/slugify.js"), "utf8");
            assert(source.includes("export"), "slugify module does not use the repository's ESM convention");
            assert(result.trace.some((turn) => turn.tools.some((tool) => tool.name === "git_status")), "agent did not inspect git status");
            assert(result.trace.some((turn) => turn.tools.some((tool) => tool.name === "git_diff")), "agent did not inspect the final diff");
            await runNodeTests(root);
            return "missing ESM module created; independent node:test passed; git review tools used";
        },
    },
    {
        level: 3,
        id: "03-multifile-regression",
        description: "Diagnose a multi-file behavior while preserving unrelated code",
        task: "Fix the user registration regression. Empty or whitespace-only names must be rejected, while valid names should be trimmed before storage. Keep the public API unchanged, preserve unrelated behavior, run all tests, and review the final diff.",
        fixture: {
            "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2),
            "src/validate.js": "export function validName(name) {\n  return typeof name === 'string' && name.length > 0;\n}\n",
            "src/users.js": "import { validName } from './validate.js';\nexport function register(store, name) {\n  if (!validName(name)) throw new Error('invalid name');\n  const user = { id: store.length + 1, name };\n  store.push(user);\n  return user;\n}\nexport function findUser(store, id) { return store.find((user) => user.id === id); }\n",
            "test/users.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { register, findUser } from '../src/users.js';\ntest('rejects blank names', () => { assert.throws(() => register([], '   '), /invalid name/); });\ntest('trims stored names', () => { const users=[]; assert.equal(register(users, '  Ada  ').name, 'Ada'); });\ntest('preserves lookup behavior', () => { const users=[{id:4,name:'Lin'}]; assert.equal(findUser(users,4).name,'Lin'); });\n",
            "README.md": "# Tiny users service\n\nDo not replace this documentation during a bug fix.\n",
        },
        verify: async (root, result) => {
            await runNodeTests(root);
            const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
            assert(readme.includes("Do not replace"), "unrelated documentation was changed");
            const writeTargets = result.trace.flatMap((turn) => turn.tools.filter((tool) => ["write_file", "edit_file"].includes(tool.name)).map((tool) => String(tool.input.path)));
            assert(writeTargets.every((target) => target.startsWith("src/")), `agent modified unrelated paths: ${writeTargets.join(", ")}`);
            return "all regression tests passed independently and unrelated documentation was preserved";
        },
    },
];

async function createRepository(fixture: Fixture): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-eval-"));
    for (const [relativePath, content] of Object.entries(fixture)) {
        const target = path.join(root, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
    }
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=Eval Fixture", "-c", "user.email=eval@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    return root;
}

async function runEval(testCase: CodingEval, model: string): Promise<EvalResult> {
    const started = Date.now();
    let root: string | undefined;
    let result: CodingAgentResult | undefined;
    try {
        root = await createRepository(testCase.fixture);
        const agent = new CodingAgent({ model, workspace: root, maxIterations: 20 });
        result = await agent.run(testCase.task);
        assert(result.stoppedBy === "model", `agent stopped by ${result.stoppedBy}`);
        const evidence = await testCase.verify(root, result);
        const toolsUsed = result.trace.flatMap((turn) => turn.tools.map((tool) => tool.name));
        return { id: testCase.id, level: testCase.level, passed: true, durationMs: Date.now() - started, iterations: result.iterations, toolsUsed, evidence };
    } catch (error) {
        return {
            id: testCase.id,
            level: testCase.level,
            passed: false,
            durationMs: Date.now() - started,
            iterations: result?.iterations ?? 0,
            toolsUsed: result?.trace.flatMap((turn) => turn.tools.map((tool) => tool.name)) ?? [],
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        if (root) await fs.rm(root, { recursive: true, force: true });
    }
}

export async function runCodingEvals(model = process.env.CODING_MODEL ?? process.env.MODEL ?? "claude-sonnet-4-6", selectedIds: string[] = []): Promise<EvalResult[]> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for live coding evals.");
    const selected = selectedIds.length ? codingEvals.filter((testCase) => selectedIds.includes(testCase.id)) : codingEvals;
    assert(selected.length > 0, `No eval matched: ${selectedIds.join(", ")}`);
    console.log(`Running ${selected.length} live coding eval(s) with ${model}\n`);
    const results: EvalResult[] = [];
    for (const testCase of selected) {
        console.log(`[level ${testCase.level}] ${testCase.id}: ${testCase.description}`);
        const result = await runEval(testCase, model);
        results.push(result);
        console.log(result.passed
            ? `  PASS (${result.durationMs}ms, ${result.iterations} iterations, ${result.toolsUsed.length} tool calls)\n`
            : `  FAIL (${result.error})\n`);
    }
    return results;
}

async function main(): Promise<void> {
    const results = await runCodingEvals(undefined, process.argv.slice(2));
    const passed = results.filter((result) => result.passed).length;
    console.log(`Coding-agent evals: ${passed}/${results.length} passed`);
    for (const result of results.filter((item) => !item.passed)) console.log(`- ${result.id}: ${result.error}`);
    if (passed !== results.length) process.exitCode = 1;
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("/codingAgentHarness/evals.js");
if (isDirectRun) main().catch((error) => { console.error(error); process.exitCode = 1; });
