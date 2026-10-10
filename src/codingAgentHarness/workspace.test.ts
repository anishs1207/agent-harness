import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "./workspace.js";
import { createCodingTools } from "./tools.js";
import { verifyCompletion } from "./index.js";

test("workspace file tools stay scoped and edit exact text", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-harness-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = new Workspace(root);

    await workspace.writeFile("src/example.txt", "alpha\nbeta\n");
    assert.match(await workspace.readFile("src/example.txt"), /2: beta/);
    await workspace.editFile("src/example.txt", "beta", "gamma");
    assert.match(await workspace.readFile("src/example.txt"), /2: gamma/);
    assert.throws(() => workspace.resolve("../outside.txt"), /escapes workspace/);
});

test("workspace rejects ambiguous edits and destructive commands", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-harness-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = new Workspace(root);
    await workspace.writeFile("duplicate.txt", "same same");

    await assert.rejects(() => workspace.editFile("duplicate.txt", "same", "new"), /found 2/);
    await assert.rejects(() => workspace.run("git reset --hard"), /blocked/);
});

test("unified patches apply atomically", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-harness-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = new Workspace(root);
    await workspace.writeFile("example.txt", "one\ntwo\nthree\n");
    await workspace.applyPatch("example.txt", "@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+two-and-a-half\n three");
    assert.equal(await fs.readFile(path.join(root, "example.txt"), "utf8"), "one\nTWO\ntwo-and-a-half\nthree\n");
    await assert.rejects(() => workspace.applyPatch("example.txt", "@@ -1,1 +1,1 @@\n-wrong\n+value"), /mismatch/);
    assert.equal(await fs.readFile(path.join(root, "example.txt"), "utf8"), "one\nTWO\ntwo-and-a-half\nthree\n");
});

test("permissions stop mutations before execution", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coding-harness-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tools = createCodingTools(new Workspace(root), () => false);
    await assert.rejects(() => tools.byName.get("write_file")!.execute({ path: "blocked.txt", content: "no" }), /Permission denied/);
    await assert.rejects(() => fs.access(path.join(root, "blocked.txt")));
});

test("completion verification requires tests and final git review after edits", () => {
    const event = (name: string, input: Record<string, unknown> = {}) => ({ name, input, output: "ok", isError: false });
    const incomplete = verifyCompletion([{ iteration: 1, tools: [event("edit_file"), event("git_diff")] }]);
    assert.equal(incomplete.passed, false);
    assert.deepEqual(incomplete.reasons, [
        "run a relevant test, build, lint, or type-check command after the final edit",
        "inspect git_status after the final edit",
    ]);
    const complete = verifyCompletion([{ iteration: 1, tools: [
        event("apply_patch"),
        event("run_command", { command: "node --test" }),
        event("git_status"),
        event("git_diff"),
    ] }]);
    assert.equal(complete.passed, true);
});
