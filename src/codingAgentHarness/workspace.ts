import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 30_000;

export class Workspace {
    readonly root: string;

    constructor(root = process.cwd()) {
        this.root = path.resolve(root);
    }

    resolve(relativePath = "."): string {
        const target = path.resolve(this.root, relativePath);
        const relative = path.relative(this.root, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Path escapes workspace: ${relativePath}`);
        }
        return target;
    }

    displayPath(absolutePath: string): string {
        return path.relative(this.root, absolutePath) || ".";
    }

    async readFile(relativePath: string, startLine = 1, endLine?: number): Promise<string> {
        const target = this.resolve(relativePath);
        await this.rejectSymlinks(target);
        const content = await fs.readFile(target, "utf8");
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, startLine);
        const end = Math.min(lines.length, endLine ?? start + 399);
        return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
    }

    async listFiles(relativePath = ".", depth = 3): Promise<string> {
        const root = this.resolve(relativePath);
        await this.rejectSymlinks(root);
        const output: string[] = [];
        const walk = async (directory: string, level: number): Promise<void> => {
            if (level > depth || output.length >= 1_000) return;
            const entries = await fs.readdir(directory, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
                const absolute = path.join(directory, entry.name);
                output.push(this.displayPath(absolute) + (entry.isDirectory() ? "/" : ""));
                if (entry.isDirectory()) await walk(absolute, level + 1);
            }
        };
        await walk(root, 0);
        return output.join("\n") || "(empty directory)";
    }

    async writeFile(relativePath: string, content: string): Promise<string> {
        const target = this.resolve(relativePath);
        await this.rejectSymlinks(target, true);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return `Wrote ${Buffer.byteLength(content)} bytes to ${this.displayPath(target)}`;
    }

    async editFile(relativePath: string, oldText: string, newText: string): Promise<string> {
        const target = this.resolve(relativePath);
        await this.rejectSymlinks(target);
        const content = await fs.readFile(target, "utf8");
        const occurrences = content.split(oldText).length - 1;
        if (occurrences !== 1) {
            throw new Error(`Expected old_text exactly once in ${relativePath}, found ${occurrences}`);
        }
        await fs.writeFile(target, content.replace(oldText, newText), "utf8");
        return `Edited ${this.displayPath(target)}`;
    }

    async applyPatch(relativePath: string, patchText: string): Promise<string> {
        const target = this.resolve(relativePath);
        await this.rejectSymlinks(target);
        const original = await fs.readFile(target, "utf8");
        const hadFinalNewline = original.endsWith("\n");
        const source = original.replace(/\r\n/g, "\n").split("\n");
        if (hadFinalNewline) source.pop();
        const patchLines = patchText.replace(/\r\n/g, "\n").split("\n");
        const output: string[] = [];
        let sourceIndex = 0;
        let patchIndex = 0;
        let hunks = 0;

        while (patchIndex < patchLines.length) {
            const line = patchLines[patchIndex];
            if (line.startsWith("---") || line.startsWith("+++") || line === "") {
                patchIndex++;
                continue;
            }
            const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (!header) throw new Error(`Invalid unified patch line: ${line}`);
            const oldStart = Number(header[1]) - 1;
            if (oldStart < sourceIndex || oldStart > source.length) throw new Error("Patch hunk is out of order or outside the file.");
            output.push(...source.slice(sourceIndex, oldStart));
            sourceIndex = oldStart;
            patchIndex++;
            hunks++;
            let oldCount = 0;
            let newCount = 0;
            while (patchIndex < patchLines.length && !patchLines[patchIndex].startsWith("@@ ")) {
                const patchLine = patchLines[patchIndex++];
                if (patchLine === "\\ No newline at end of file") continue;
                const marker = patchLine[0];
                const text = patchLine.slice(1);
                if (marker === " ") {
                    if (source[sourceIndex] !== text) throw new Error(`Patch context mismatch at line ${sourceIndex + 1}.`);
                    output.push(text);
                    sourceIndex++;
                    oldCount++;
                    newCount++;
                } else if (marker === "-") {
                    if (source[sourceIndex] !== text) throw new Error(`Patch removal mismatch at line ${sourceIndex + 1}.`);
                    sourceIndex++;
                    oldCount++;
                } else if (marker === "+") {
                    output.push(text);
                    newCount++;
                } else if (patchLine !== "") {
                    throw new Error(`Invalid patch content line: ${patchLine}`);
                }
            }
            const expectedOld = Number(header[2] ?? 1);
            const expectedNew = Number(header[4] ?? 1);
            if (oldCount !== expectedOld || newCount !== expectedNew) {
                throw new Error(`Patch hunk count mismatch: expected -${expectedOld}/+${expectedNew}, got -${oldCount}/+${newCount}.`);
            }
        }
        if (hunks === 0) throw new Error("Patch contains no hunks.");
        output.push(...source.slice(sourceIndex));
        await fs.writeFile(target, output.join("\n") + (hadFinalNewline ? "\n" : ""), "utf8");
        return `Applied ${hunks} patch hunk(s) to ${this.displayPath(target)}`;
    }

    async search(query: string, relativePath = "."): Promise<string> {
        const target = this.resolve(relativePath);
        await this.rejectSymlinks(target);
        const args = ["--line-number", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "--", query, target];
        try {
            const { stdout } = await execFileAsync("rg", args, { cwd: this.root, timeout: 15_000, maxBuffer: 2_000_000 });
            return this.limit(stdout.replaceAll(this.root + path.sep, ""));
        } catch (error: any) {
            if (error.code === 1) return "No matches found.";
            throw error;
        }
    }

    async run(command: string, timeoutMs = 120_000): Promise<string> {
        this.assertSafeCommand(command);
        const isWindows = process.platform === "win32";
        const executable = isWindows ? "powershell.exe" : "/bin/sh";
        const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
        try {
            const { stdout, stderr } = await execFileAsync(executable, args, {
                cwd: this.root,
                timeout: Math.min(Math.max(timeoutMs, 1_000), 300_000),
                maxBuffer: 4_000_000,
                windowsHide: true,
            });
            return this.limit([stdout, stderr].filter(Boolean).join("\n").trim() || "Command completed successfully (no output)." );
        } catch (error: any) {
            const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
            throw new Error(this.limit(output));
        }
    }

    async gitStatus(): Promise<string> {
        return this.runProgram("git", ["status", "--short"]);
    }

    async gitDiff(staged = false): Promise<string> {
        return this.runProgram("git", ["diff", ...(staged ? ["--staged"] : []), "--"]);
    }

    private assertSafeCommand(command: string): void {
        const blocked = [
            /\bgit\s+(reset\s+--hard|clean\s+-[^\s]*f)/i,
            /\brm\s+-[^\s]*r[^\s]*f?\s+(\/|~|\$HOME)\b/i,
            /\bRemove-Item\b[^\r\n]*(?:-Recurse[^\r\n]*-Force|-Force[^\r\n]*-Recurse)[^\r\n]*(?:\\|\$HOME)\b/i,
            /\b(format|mkfs|shutdown|reboot)\b/i,
        ];
        if (blocked.some((pattern) => pattern.test(command))) {
            throw new Error("Command blocked by the coding harness safety policy.");
        }
    }

    private async runProgram(executable: string, args: string[]): Promise<string> {
        try {
            const { stdout, stderr } = await execFileAsync(executable, args, {
                cwd: this.root,
                timeout: 30_000,
                maxBuffer: 4_000_000,
                windowsHide: true,
            });
            return this.limit([stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)");
        } catch (error: any) {
            const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
            throw new Error(this.limit(output));
        }
    }

    private async rejectSymlinks(target: string, allowMissing = false): Promise<void> {
        const relative = path.relative(this.root, target);
        let current = this.root;
        for (const segment of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, segment);
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) {
                    throw new Error(`Symbolic links are not allowed in workspace paths: ${this.displayPath(current)}`);
                }
            } catch (error: any) {
                if (allowMissing && error.code === "ENOENT") return;
                throw error;
            }
        }
    }

    private limit(value: string): string {
        return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n... output truncated ...`;
    }
}
