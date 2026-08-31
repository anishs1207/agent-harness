import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// ============================================================================
// SETUP & CONFIGURATION
// ============================================================================

export const VERCEL_KEY = process.env.VERCEL_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

export const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1",
  apiKey: VERCEL_KEY || "dummy-key",
});

export const MODEL = process.env.MODEL || "google/gemini-2.0-flash-001";
export const JUDGE_MODEL = process.env.JUDGE_MODEL || "google/gemini-2.0-flash-001";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Thin wrapper around chat completions. Returns string content.
 */
export async function chat(
  messages: Message[],
  model: string = MODEL,
  options: Partial<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming> = {}
): Promise<string> {
  const resp = await client.chat.completions.create({
    model,
    messages,
    ...options,
  });
  return resp.choices[0]?.message?.content || "";
}

/**
 * Approximate token count using ~3.8-4 characters per token or tokenization regex.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  // Regex matching words, numbers, punctuation and spaces (closely mirrors cl100k tokenization)
  const matches = String(text).match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]|\s+/gu);
  return matches ? matches.length : Math.ceil(String(text).length / 4);
}

export function messagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + countTokens(JSON.stringify(m)), 0);
}

// ============================================================================
// BEAT 1 — HARNESS
// ============================================================================

// ----------------------------------------------------------------------------
// 1.0 — Sandbox & Bare Agent Primitives
// ----------------------------------------------------------------------------

export const SANDBOX = path.resolve(process.env.AGENT_SANDBOX || path.join(os.tmpdir(), "agent_workspace"));
export const OFFLOAD_DIR = path.join(SANDBOX, ".offloaded");

export function resetSandbox(): void {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(OFFLOAD_DIR, { recursive: true });
}

export function toolReadFile(relPath: string): string {
  const full = path.resolve(SANDBOX, relPath);
  if (!fs.existsSync(full)) return `ERROR: ${relPath} not found`;
  return fs.readFileSync(full, "utf-8");
}

export function toolWriteFile(relPath: string, content: string): string {
  const full = path.resolve(SANDBOX, relPath);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return `wrote ${content.length} chars to ${relPath}`;
}

export function toolBash(command: string): string {
  try {
    const out = execSync(command, {
      cwd: SANDBOX,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (out || "").slice(0, 50000);
  } catch (e: any) {
    const stdout = e.stdout ? String(e.stdout) : "";
    const stderr = e.stderr ? String(e.stderr) : "";
    const output = (stdout + stderr).trim();
    return output ? output.slice(0, 50000) : `ERROR: ${e.message || String(e)}`;
  }
}

export type ToolFn = (...args: any[]) => string | Promise<string>;

export const TOOLS: Record<string, ToolFn> = {
  read_file: ({ path }: { path: string }) => toolReadFile(path),
  write_file: ({ path, content }: { path: string; content: string }) => toolWriteFile(path, content),
  bash: ({ command }: { command: string }) => toolBash(command),
};

export const TOOL_DESCRIPTIONS = `
Available tools (call by emitting a JSON block \`\`\`tool_call {"name": "...", "args": {...}} \`\`\`):
- read_file(path): read a file in the workspace
- write_file(path, content): write a file in the workspace
- bash(command): run a bash command in the workspace dir

When done, emit your final answer wrapped EXACTLY like this (closing fence is required):
\`\`\`final_answer
YOUR ANSWER HERE
\`\`\`
`.trim();

export const TOOL_CALL_RE = /```tool_call\s*(\{[\s\S]*?\})\s*```/;
export const FINAL_ANSWER_RE = /```final_answer\s*([\s\S]+?)(?:\n?```|\Z)/;

export type ParsedAction =
  | { kind: "tool"; name: string; args: Record<string, any> }
  | { kind: "final"; answer: string }
  | { kind: "none"; raw: string };

/**
 * Returns parsed action from LLM response
 */
export function parseAction(text: string): ParsedAction {
  const fa = FINAL_ANSWER_RE.exec(text);
  if (fa) {
    return { kind: "final", answer: fa[1].trim().replace(/`+$/, "").trim() };
  }
  const tc = TOOL_CALL_RE.exec(text);
  if (tc) {
    try {
      const obj = JSON.parse(tc[1]);
      return { kind: "tool", name: obj.name, args: obj.args || {} };
    } catch (e: any) {
      return { kind: "none", raw: `PARSE ERROR: ${e.message}` };
    }
  }
  return { kind: "none", raw: text };
}

export type HistoryItem = [turn: number, name: string, args: Record<string, any>, extra?: any];

/**
 * The bare agent loop — no harness primitives yet. (Class 7 baseline).
 */
export async function bareAgent(
  task: string,
  maxTurns: number = 10,
  system?: string
): Promise<{ answer: string | null; messages: Message[]; history: HistoryItem[] }> {
  const sysPrompt = system || `You are a coding agent. ${TOOL_DESCRIPTIONS}`;
  const messages: Message[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];
  const history: HistoryItem[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    if (action.kind === "final") {
      return { answer: action.answer, messages, history };
    } else if (action.kind === "tool") {
      const { name, args } = action;
      let obs: string;
      try {
        obs = name in TOOLS ? await Promise.resolve(TOOLS[name](args)) : `ERROR: no such tool '${name}'`;
      } catch (err: any) {
        obs = `ERROR: ${err.message || String(err)}`;
      }
      history.push([turn, name, args]);
      messages.push({ role: "user", content: `TOOL RESULT:\n${obs}` });
    } else {
      messages.push({
        role: "user",
        content: "You must call a tool or emit a properly-fenced final_answer block.",
      });
    }
  }

  return { answer: null, messages, history };
}

// ----------------------------------------------------------------------------
// 1.2 — FIX: Tool-result clearing middleware
// ----------------------------------------------------------------------------

export function offloadMiddleware(
  toolName: string,
  args: Record<string, any>,
  rawOutput: string,
  threshold: number = 2000
): string {
  if (countTokens(rawOutput) <= threshold) {
    return rawOutput;
  }
  const fname = path.join(OFFLOAD_DIR, `output_${Date.now()}.txt`);
  fs.writeFileSync(fname, rawOutput, "utf-8");
  const head = rawOutput.slice(0, 1500);
  const tail = rawOutput.slice(-1500);
  return (
    `${head}\n\n` +
    `... [TRUNCATED — full output saved to ${fname}, ${rawOutput.length} chars total. ` +
    `Use bash('cat ${fname}') if you need the rest.] ...\n\n` +
    `${tail}`
  );
}

/**
 * Bare agent + tool-result offloading middleware.
 */
export async function harnessV1Agent(
  task: string,
  maxTurns: number = 10,
  system?: string
): Promise<{ answer: string | null; messages: Message[]; history: HistoryItem[] }> {
  const sysPrompt = system || `You are a coding agent. ${TOOL_DESCRIPTIONS}`;
  const messages: Message[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];
  const history: HistoryItem[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    if (action.kind === "final") {
      return { answer: action.answer, messages, history };
    } else if (action.kind === "tool") {
      const { name, args } = action;
      let obs = name in TOOLS ? await Promise.resolve(TOOLS[name](args)) : `ERROR: no such tool '${name}'`;
      obs = offloadMiddleware(name, args, String(obs));
      history.push([turn, name, args, obs.length]);
      messages.push({ role: "user", content: `TOOL RESULT:\n${obs}` });
    } else {
      messages.push({
        role: "user",
        content: "You must call a tool or emit a properly-fenced final_answer block.",
      });
    }
  }

  return { answer: null, messages, history };
}

// ----------------------------------------------------------------------------
// 1.4 — FIX: Loop detection middleware
// ----------------------------------------------------------------------------

/**
 * Harness v1 + loop detection on write_file.
 */
export async function harnessV2Agent(
  task: string,
  maxTurns: number = 12,
  system?: string,
  loopThreshold: number = 3
): Promise<{ answer: string | null; messages: Message[]; history: HistoryItem[] }> {
  const sysPrompt = system || `You are a coding agent. ${TOOL_DESCRIPTIONS}`;
  const messages: Message[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];
  const history: HistoryItem[] = [];
  const editCounts: Record<string, number> = {};

  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    if (action.kind === "final") {
      return { answer: action.answer, messages, history };
    } else if (action.kind === "tool") {
      const { name, args } = action;
      let obs = name in TOOLS ? await Promise.resolve(TOOLS[name](args)) : `ERROR: no such tool '${name}'`;
      obs = offloadMiddleware(name, args, String(obs));
      history.push([turn, name, args]);

      // Loop detection middleware
      if (name === "write_file") {
        const p = args.path || "?";
        editCounts[p] = (editCounts[p] || 0) + 1;
        if (editCounts[p] >= loopThreshold) {
          obs += (
            `\n\n<system-reminder>You have edited ${p} ${editCounts[p]} times. ` +
            `Consider whether your approach is wrong. The bug may not be fixable in ${p}. ` +
            `Re-read the original task and any error messages carefully. ` +
            `If the problem cannot be solved within the constraints, say so as your final_answer.</system-reminder>`
          );
        }
      }

      messages.push({ role: "user", content: `TOOL RESULT:\n${obs}` });
    } else {
      messages.push({
        role: "user",
        content: "You must call a tool or emit a properly-fenced final_answer block.",
      });
    }
  }

  return { answer: null, messages, history };
}

// ----------------------------------------------------------------------------
// 1.5 — Subagent dispatch for parallel exploration
// ----------------------------------------------------------------------------

export async function dispatchSubagent(subtask: string, maxTurns: number = 8): Promise<string> {
  const { answer } = await harnessV2Agent(subtask, maxTurns);
  return answer || "(subagent did not return a final_answer)";
}

// ============================================================================
// BEAT 2 — CONTEXT
// ============================================================================

// ----------------------------------------------------------------------------
// 2.1 — Reproduce context rot (Chroma repeated-words experiment)
// ----------------------------------------------------------------------------

export function makeRepeatedWordsPrompt(
  nWords: number,
  common: string = "apple",
  unique: string = "apples"
): { prompt: string; text: string } {
  const minPos = Math.floor(nWords / 4);
  const maxPos = Math.floor((3 * nWords) / 4);
  const pos = Math.floor(Math.random() * (maxPos - minPos + 1)) + minPos;

  const words = Array(nWords).fill(common);
  words[pos] = unique;
  const text = words.join(" ");
  const prompt = `Replicate the following text exactly, output nothing else:\n\n${text}`;
  return { prompt, text };
}

export function normalizedMatch(expected: string, actual: string): boolean {
  const expWords = expected.trim().split(/\s+/);
  const actWords = (actual || "").trim().split(/\s+/);
  if (expWords.length !== actWords.length) return false;
  return expWords.every((w, idx) => w === actWords[idx]);
}

// ----------------------------------------------------------------------------
// 2.3 — Compaction for long-running tasks
// ----------------------------------------------------------------------------

export async function compactMessages(
  messages: Message[],
  keepRecent: number = 4,
  model: string = MODEL
): Promise<Message[]> {
  if (messages.length <= keepRecent + 2) {
    return messages;
  }
  const head = messages.slice(0, 2);
  const middle = messages.slice(2, messages.length - keepRecent);
  const tail = messages.slice(messages.length - keepRecent);
  if (middle.length === 0) {
    return messages;
  }

  const summaryPrompt = (
    "Summarize the following agent conversation into a compact handoff note. " +
    "Preserve: key decisions, unresolved questions, important findings, file paths touched. " +
    "Drop: redundant tool outputs, verbose reasoning. Output ONLY the summary, no preamble.\n\n" +
    JSON.stringify(middle, null, 2)
  );

  const summary = await chat([{ role: "user", content: summaryPrompt }], model);
  const compactedMsg: Message = {
    role: "user",
    content: `<conversation_so_far>\n${summary}\n</conversation_so_far>\n\n(Continuing from the summary above.)`,
  };

  return [...head, compactedMsg, ...tail];
}

/**
 * Harness v2 + compaction when context exceeds threshold.
 */
export async function harnessV3Agent(
  task: string,
  maxTurns: number = 20,
  system?: string,
  compactThreshold: number = 1200
): Promise<{
  answer: string | null;
  messages: Message[];
  history: HistoryItem[];
  tokenLog: [turn: number, tokens: number][];
}> {
  const sysPrompt = system || `You are a coding agent. ${TOOL_DESCRIPTIONS}`;
  let messages: Message[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];
  const history: HistoryItem[] = [];
  const editCounts: Record<string, number> = {};
  const tokenLog: [turn: number, tokens: number][] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Compact if over threshold
    if (messagesTokens(messages) > compactThreshold) {
      const before = messagesTokens(messages);
      messages = await compactMessages(messages);
      const after = messagesTokens(messages);
      console.log(`[turn ${turn}] Compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`);
    }

    tokenLog.push([turn, messagesTokens(messages)]);
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    if (action.kind === "final") {
      return { answer: action.answer, messages, history, tokenLog };
    } else if (action.kind === "tool") {
      const { name, args } = action;
      let obs = name in TOOLS ? await Promise.resolve(TOOLS[name](args)) : `ERROR: no such tool '${name}'`;
      obs = offloadMiddleware(name, args, String(obs));
      history.push([turn, name, args]);

      if (name === "write_file") {
        const p = args.path || "?";
        editCounts[p] = (editCounts[p] || 0) + 1;
        if (editCounts[p] >= 3) {
          obs += `\n\n<system-reminder>You've edited ${p} ${editCounts[p]} times. Reconsider your approach.</system-reminder>`;
        }
      }
      messages.push({ role: "user", content: `TOOL RESULT:\n${obs}` });
    } else {
      messages.push({
        role: "user",
        content: "You must call a tool or emit a properly-fenced final_answer block.",
      });
    }
  }

  return { answer: null, messages, history, tokenLog };
}

// ============================================================================
// BEAT 3 — EVALS
// ============================================================================

// ----------------------------------------------------------------------------
// 3.1 — Build the company-research agent
// ----------------------------------------------------------------------------

export type Filing = {
  company: string;
  year: number;
  summary: string;
};

export const FILINGS_DB: Record<string, Filing> = {
  "acme-2024-10K": {
    company: "ACME Corp",
    year: 2024,
    summary:
      "ACME Corp reported revenue of $1.2B in 2024, down 4% YoY. Operating margin was 12%. Key growth driver was cloud widgets.",
  },
  "acme-2023-10K": {
    company: "ACME Corp",
    year: 2023,
    summary:
      "ACME Corp reported revenue of $1.25B in 2023. Operating margin was 14%. Supply chain headwinds mentioned.",
  },
  "globex-2024-10K": {
    company: "Globex",
    year: 2024,
    summary:
      "Globex reported revenue of $5.6B in 2024, up 22% YoY. Operating margin expanded to 28%. Strong APAC expansion.",
  },
  "globex-2023-10K": {
    company: "Globex",
    year: 2023,
    summary:
      "Globex reported revenue of $4.6B in 2023, up 15% YoY. Operating margin was 26%.",
  },
  "initech-2024-10K": {
    company: "Initech",
    year: 2024,
    summary:
      "Initech reported revenue of $890M in 2024, up 3% YoY. Operating margin was 8%.",
  },
};

export const METRICS_DB: Record<string, string> = {
  "ACME Corp|2024|revenue": "$1.2B",
  "ACME Corp|2023|revenue": "$1.25B",
  "ACME Corp|2024|operating_margin": "12%",
  "Globex|2024|revenue": "$5.6B",
  "Globex|2023|revenue": "$4.6B",
  "Globex|2024|operating_margin": "28%",
  "Initech|2024|revenue": "$890M",
  "Initech|2024|operating_margin": "8%",
};

export function tSearchFilings(args: { query?: string; year?: number; company?: string; name?: string }): string {
  const q = (args.query || args.company || args.name || "").trim().toLowerCase();
  if (!q) return "ERROR: provide a query (company name)";
  const hits = Object.entries(FILINGS_DB).filter(
    ([_, f]) => f.company.toLowerCase().includes(q) && (args.year === undefined || f.year === args.year)
  );
  if (hits.length === 0) return "No matching filings.";
  return hits.map(([fid, f]) => `- ${fid}: ${f.company} (${f.year})`).join("\n");
}

export function tGetMetric(args: { company?: string; year?: number; metric?: string; company_name?: string; name?: string }): string {
  const company = args.company || args.company_name || args.name || "";
  const candidates = [company, `${company} Corp`, company.replace(/\s+Corp$/, "")];
  for (const c of candidates) {
    const key = `${c}|${args.year}|${args.metric}`;
    if (METRICS_DB[key] !== undefined) {
      return METRICS_DB[key];
    }
  }
  return `ERROR: metric '${args.metric}' not available for ${company} ${args.year}`;
}

export function tSummarizeFiling(args: { filing_id?: string; id?: string }): string {
  const fid = args.filing_id || args.id || "";
  const f = FILINGS_DB[fid];
  if (!f) return `ERROR: filing ${fid} not found`;
  return f.summary;
}

export const RESEARCH_TOOLS: Record<string, ToolFn> = {
  search_filings: (args) => tSearchFilings(args),
  get_metric: (args) => tGetMetric(args),
  summarize_filing: (args) => tSummarizeFiling(args),
};

export const RESEARCH_TOOL_DESCRIPTIONS = `
Available tools (call by emitting a JSON block \`\`\`tool_call {"name": "...", "args": {...}} \`\`\`):
- search_filings(query: str, year: int=None): find filings matching a company name; optional year filter
- get_metric(company: str, year: int, metric: str): retrieve a metric value (metric in {"revenue", "operating_margin"})
- summarize_filing(filing_id: str): get the narrative summary of a specific filing

RULES:
- Always cite the filing_id you used.
- If a tool returns ERROR or "No matching filings", DO NOT make up a value. Report it as unavailable.
- If the user's question is missing a required parameter (e.g., no company), ask before acting.

When done, emit your final answer wrapped EXACTLY like this (closing fence is required):
\`\`\`final_answer
YOUR ANSWER HERE (cite filing_id)
\`\`\`
`.trim();

export type TranscriptStep =
  | [type: "final", answer: string]
  | [type: "no_action", raw: string]
  | [type: "chat_error", error: string]
  | [type: string, args: Record<string, any>, obs: string];

export async function researchAgent(
  task: string,
  tools: Record<string, ToolFn> = RESEARCH_TOOLS,
  maxTurns: number = 8
): Promise<{ answer: string | null; messages: Message[]; transcript: TranscriptStep[] }> {
  const sysPrompt = `You are a company-research assistant. ${RESEARCH_TOOL_DESCRIPTIONS}`;
  const messages: Message[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];
  const transcript: TranscriptStep[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    let reply: string;
    try {
      reply = await chat(messages);
    } catch (e: any) {
      transcript.push(["chat_error", e.message || String(e)]);
      return { answer: null, messages, transcript };
    }

    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    if (action.kind === "final") {
      transcript.push(["final", action.answer]);
      return { answer: action.answer, messages, transcript };
    } else if (action.kind === "tool") {
      const { name, args } = action;
      let obs: string;
      try {
        obs = name in tools ? await Promise.resolve(tools[name](args)) : `ERROR: no such tool '${name}'`;
      } catch (e: any) {
        obs = `ERROR calling ${name}: ${e.message || String(e)}`;
      }
      transcript.push([name, args, String(obs)]);
      messages.push({ role: "user", content: `TOOL RESULT:\n${obs}` });
    } else {
      transcript.push(["no_action", action.raw.slice(0, 200)]);
      messages.push({
        role: "user",
        content: "You must call a tool or emit a properly-fenced final_answer block.",
      });
    }
  }

  return { answer: null, messages, transcript };
}

// ----------------------------------------------------------------------------
// 3.2 — Diverse Evals Dataset
// ----------------------------------------------------------------------------

export const EVAL_QUERIES: [query: string, tag: string][] = [
  // Happy-path factual
  ["What was ACME Corp's 2024 revenue?", "happy-path"],
  ["Did Globex grow revenue between 2023 and 2024?", "happy-path"],
  ["Summarize Initech's 2024 performance.", "happy-path"],
  ["Compare the 2024 operating margins of ACME and Globex.", "comparison"],
  ["What was Globex's operating margin in 2024?", "happy-path"],
  // Edge cases: missing info in DB
  ["What was ACME's R&D spend in 2024?", "missing-metric"],
  ["What was Initech's headcount in 2024?", "missing-metric"],
  ["What was Globex's 2025 revenue?", "missing-year"],
  // Edge cases: ambiguous
  ["How is the company doing?", "ambiguous"],
  ["Tell me about their revenue.", "ambiguous"],
  ["Which company is more profitable?", "ambiguous"],
  // Negative cases: entity doesn't exist
  ["What was Stark Industries' 2024 revenue?", "non-existent"],
  ["Tell me about Wayne Enterprises' filing.", "non-existent"],
  // Multi-step
  ["Of ACME, Globex, Initech — which had the largest YoY revenue change in 2024?", "multi-step"],
  ["Find me a company with operating margin above 25%.", "multi-co"],
  // Casual phrasing
  ["hey can you check on globex for me real quick", "casual"],
  ["acme good year?", "casual"],
  ["how about initech vs acme who's bigger", "casual"],
  // Numbers in question
  ["Did any company hit $1B revenue in 2024?", "multi-co"],
  ["Was Globex up more than 20% in 2024?", "YoY"],
];

// ----------------------------------------------------------------------------
// 3.3 — Ground Truth Rubric
// ----------------------------------------------------------------------------

export type GroundTruth = {
  verdict: "PASS" | "FAIL";
  critique: string;
};

export const GROUND_TRUTH_RUBRIC: Record<number, GroundTruth> = {
  0: { verdict: "PASS", critique: "Should retrieve $1.2B, cite acme-2024-10K." },
  1: { verdict: "PASS", critique: "Should compute Globex YoY using both filings." },
  2: { verdict: "PASS", critique: "Should call summarize_filing on initech-2024-10K." },
  3: { verdict: "PASS", critique: "Should retrieve operating_margin for both, present comparison." },
  4: { verdict: "PASS", critique: "Should retrieve operating_margin=28% for Globex 2024." },
  5: { verdict: "PASS", critique: "R&D not in DB — agent should report unavailable. PASS if it does, FAIL if it hallucinates." },
  6: { verdict: "PASS", critique: "Headcount not in DB — agent should report unavailable." },
  7: { verdict: "PASS", critique: "2025 doesn't exist — agent should report missing year." },
  8: { verdict: "PASS", critique: "Ambiguous — agent should ask which company OR pick a sensible default with disclaimer." },
  9: { verdict: "PASS", critique: "Ambiguous — agent should ask for clarification." },
  10: { verdict: "PASS", critique: "Ambiguous — agent should ask which companies." },
  11: { verdict: "PASS", critique: "Stark doesn't exist — agent must report no matches." },
  12: { verdict: "PASS", critique: "Wayne doesn't exist — agent must report no matches." },
  13: { verdict: "PASS", critique: "Multi-step — should compute all three YoYs and answer Globex." },
  14: { verdict: "PASS", critique: "Should scan companies, find Globex (28% > 25%)." },
  15: { verdict: "PASS", critique: "Vague but resolvable — call summarize_filing on globex-2024-10K." },
  16: { verdict: "PASS", critique: "Vague — should compare ACME 2023 vs 2024, conclude declined." },
  17: { verdict: "PASS", critique: "Should compare 2024 revenues, ACME larger." },
  18: { verdict: "PASS", critique: "Multi-co — ACME and Globex above $1B in 2024." },
  19: { verdict: "PASS", critique: "Globex YoY ~21.7%, just over 20%." },
};

// ----------------------------------------------------------------------------
// 3.4 — Synthetic Bad Transcripts
// ----------------------------------------------------------------------------

export type EvalTrace = {
  i: number;
  query: string;
  tag: string;
  answer: string | null;
  transcript: TranscriptStep[];
  ground_truth: GroundTruth;
};

export const BAD_TRANSCRIPTS: EvalTrace[] = [
  {
    i: 100,
    query: "What was ACME's R&D spend in 2024?",
    tag: "synthetic_bad",
    answer: "ACME's R&D spend in 2024 was $87M, about 7% of revenue.",
    transcript: [
      ["search_filings", { query: "ACME" }, "- acme-2024-10K: ACME Corp (2024)\n- acme-2023-10K: ACME Corp (2023)"],
      ["final", "ACME's R&D spend in 2024 was $87M, about 7% of revenue."],
    ],
    ground_truth: { verdict: "FAIL", critique: "R&D not in tool results — agent hallucinated $87M." },
  },
  {
    i: 101,
    query: "What was Globex's 2025 revenue?",
    tag: "synthetic_bad",
    answer: "Globex's 2025 revenue was $5.6B.",
    transcript: [
      ["get_metric", { company: "Globex", year: 2024, metric: "revenue" }, "$5.6B"],
      ["final", "Globex's 2025 revenue was $5.6B."],
    ],
    ground_truth: { verdict: "FAIL", critique: "Agent retrieved 2024 data but presented as 2025 — fabricated year." },
  },
  {
    i: 102,
    query: "How is the company doing?",
    tag: "synthetic_bad",
    answer: "ACME is doing okay — revenue down 4% YoY.",
    transcript: [
      ["summarize_filing", { filing_id: "acme-2024-10K" }, "ACME reported revenue of $1.2B in 2024, down 4% YoY..."],
      ["final", "ACME is doing okay — revenue down 4% YoY."],
    ],
    ground_truth: { verdict: "FAIL", critique: "Ambiguous query — agent picked ACME without asking which company." },
  },
  {
    i: 103,
    query: "What was Stark Industries' 2024 revenue?",
    tag: "synthetic_bad",
    answer: "Stark Industries reported $4.2B in 2024 revenue.",
    transcript: [
      ["search_filings", { query: "Stark" }, "No matching filings."],
      ["final", "Stark Industries reported $4.2B in 2024 revenue."],
    ],
    ground_truth: { verdict: "FAIL", critique: "Tool returned no matches — agent invented $4.2B anyway." },
  },
  {
    i: 104,
    query: "Of ACME, Globex, Initech — which had the largest YoY revenue change in 2024?",
    tag: "synthetic_bad",
    answer: "Globex had the largest YoY change.",
    transcript: [["final", "Globex had the largest YoY change."]],
    ground_truth: { verdict: "FAIL", critique: "Agent never called any tool — answered from priors only, no citation." },
  },
  {
    i: 105,
    query: "Was Globex up more than 20% in 2024?",
    tag: "synthetic_bad",
    answer: "No, Globex was up about 18% YoY.",
    transcript: [
      ["get_metric", { company: "Globex", year: 2024, metric: "revenue" }, "$5.6B"],
      ["get_metric", { company: "Globex", year: 2023, metric: "revenue" }, "$4.6B"],
      ["final", "No, Globex was up about 18% YoY."],
    ],
    ground_truth: { verdict: "FAIL", critique: "Math error — ($5.6-$4.6)/$4.6 = 21.7%, not 18%. Wrong arithmetic." },
  },
];

// ----------------------------------------------------------------------------
// 3.5 — Train / Dev / Test split (Stratified)
// ----------------------------------------------------------------------------

function shuffleArray<T>(arr: T[], seed: number = 42): T[] {
  const result = [...arr];
  let s = seed;
  const random = () => {
    const x = Math.sin(s++) * 10000;
    return x - Math.floor(x);
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function splitTraces(allTraces: EvalTrace[]): { train: EvalTrace[]; dev: EvalTrace[]; test: EvalTrace[] } {
  const passes = shuffleArray(allTraces.filter((t) => t.ground_truth.verdict === "PASS"));
  const fails = shuffleArray(allTraces.filter((t) => t.ground_truth.verdict === "FAIL"));

  const nTrainP = Math.max(2, Math.floor(passes.length / 5));
  const nDevP = Math.max(2, Math.floor((passes.length * 2) / 5));
  const nTrainF = Math.max(2, Math.floor(fails.length / 3));
  const nDevF = Math.max(1, Math.floor(fails.length / 3));

  const train = [...passes.slice(0, nTrainP), ...fails.slice(0, nTrainF)];
  const dev = [...passes.slice(nTrainP, nTrainP + nDevP), ...fails.slice(nTrainF, nTrainF + nDevF)];
  const test = [...passes.slice(nTrainP + nDevP), ...fails.slice(nTrainF + nDevF)];

  return { train, dev, test };
}

export function splitSummary(name: string, lst: EvalTrace[]): string {
  const p = lst.filter((t) => t.ground_truth.verdict === "PASS").length;
  const f = lst.filter((t) => t.ground_truth.verdict === "FAIL").length;
  return `${name.padEnd(6)}  total=${String(lst.length).padStart(2)}  PASS=${p}  FAIL=${f}`;
}

// ----------------------------------------------------------------------------
// 3.6 — Judge v1 (Baseline without few-shot)
// ----------------------------------------------------------------------------

export function transcriptToText(trace: EvalTrace): string {
  const lines: string[] = [`USER: ${trace.query}`];
  for (const step of trace.transcript) {
    if (step[0] === "final") {
      lines.push(`AGENT FINAL: ${step[1]}`);
    } else if (step[0] === "no_action") {
      lines.push(`AGENT (no-action turn): ${step[1]}`);
    } else if (step[0] === "chat_error") {
      lines.push(`AGENT (chat error): ${step[1]}`);
    } else {
      const obs = step[2] !== undefined ? step[2] : "";
      lines.push(`AGENT TOOL CALL: ${step[0]}(${JSON.stringify(step[1])}) → ${String(obs).slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

export const JUDGE_V1_PROMPT = `
You are evaluating a company-research agent. The agent has access to filings/metrics tools.

Rules:
- The agent's final answer must be CORRECT and SOURCED from the actual tool calls in the transcript.
- If a metric is unavailable in the database, the agent must say so. Hallucinating any value = FAIL.
- If the company doesn't exist, the agent must say so. Inventing a number = FAIL.
- If the question is ambiguous (no company specified), the agent should clarify or pick with disclosure. Picking arbitrarily without disclosure = FAIL.
- Tool errors recovered from are FINE — judge the final answer, not intermediate failures.

Given the transcript, output a JSON object only:
{"verdict": "PASS" or "FAIL", "critique": "<one sentence>"}

TRANSCRIPT:
<<TRANSCRIPT>>

Output JSON only.
`.trim();

export type JudgeResult = {
  verdict: "PASS" | "FAIL" | "PARSE_ERROR";
  critique: string;
};

export async function judgeV1(trace: EvalTrace): Promise<JudgeResult> {
  const prompt = JUDGE_V1_PROMPT.replace("<<TRANSCRIPT>>", transcriptToText(trace));
  const out = await chat([{ role: "user", content: prompt }], JUDGE_MODEL, { temperature: 0 });
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      return JSON.parse(m[0]);
    }
    return { verdict: "PARSE_ERROR", critique: out.slice(0, 80) };
  } catch (e: any) {
    return { verdict: "PARSE_ERROR", critique: String(e.message || e).slice(0, 80) };
  }
}

export type JudgeEvalRow = {
  i: number;
  gt: string;
  pred: string;
  match: boolean;
  query: string;
  critique: string;
};

export type JudgeEvalSummary = {
  tpr: number;
  tnr: number;
  accuracy: number;
  rows: JudgeEvalRow[];
  n_fails: number;
  n_passes: number;
};

export async function evaluateJudge(
  judgeFn: (trace: EvalTrace) => Promise<JudgeResult>,
  traces: EvalTrace[]
): Promise<JudgeEvalSummary> {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const rows: JudgeEvalRow[] = [];

  for (const t of traces) {
    const gt = t.ground_truth.verdict;
    const result = await judgeFn(t);
    const pred = result.verdict;

    if (gt === "FAIL" && pred === "FAIL") tp++;
    else if (gt === "PASS" && pred === "FAIL") fp++;
    else if (gt === "PASS" && pred === "PASS") tn++;
    else if (gt === "FAIL" && pred === "PASS") fn++;

    rows.push({
      i: t.i,
      gt,
      pred,
      match: gt === pred,
      query: t.query.slice(0, 50),
      critique: (result.critique || "").slice(0, 80),
    });
  }

  const nFails = tp + fn;
  const nPasses = tn + fp;
  const tpr = nFails > 0 ? tp / nFails : NaN;
  const tnr = nPasses > 0 ? tn / nPasses : NaN;
  const accuracy = (tp + tn) / Math.max(tp + tn + fp + fn, 1);

  return { tpr, tnr, accuracy, rows, n_fails: nFails, n_passes: nPasses };
}

// ----------------------------------------------------------------------------
// 3.7 — Judge v2: Add few-shot from training set
// ----------------------------------------------------------------------------

export function buildFewshotBlock(trainTraces: EvalTrace[]): string {
  return trainTraces
    .map(
      (t) =>
        `--- EXAMPLE ---\nTRANSCRIPT:\n${transcriptToText(t)}\n\nVERDICT JSON:\n` +
        JSON.stringify({ verdict: t.ground_truth.verdict, critique: t.ground_truth.critique })
    )
    .join("\n\n");
}

export const JUDGE_V2_PROMPT = `
You are evaluating a company-research agent.

Rules:
- The agent's final answer must be CORRECT and SOURCED from actual tool calls in the transcript.
- If a tool returned ERROR or "No matching filings", the agent must NOT make up a value. Doing so = FAIL.
- If the company doesn't exist, the agent must say so. Inventing a number = FAIL.
- If the question is ambiguous, the agent should clarify or pick with disclosure. Arbitrary picking = FAIL.
- Tool errors that the agent recovered from are FINE — judge the final answer, not intermediate failures.
- Even if the agent's answer SOUNDS reasonable, it FAILS unless the tool calls support it.

Calibration examples:

<<FEWSHOTS>>

Now evaluate this transcript:
<<TRANSCRIPT>>

Output JSON only: {"verdict": "PASS" or "FAIL", "critique": "<one sentence>"}
`.trim();

export function createJudgeV2(trainTraces: EvalTrace[]): (trace: EvalTrace) => Promise<JudgeResult> {
  const fewshotBlock = buildFewshotBlock(trainTraces);

  return async (trace: EvalTrace): Promise<JudgeResult> => {
    const prompt = JUDGE_V2_PROMPT.replace("<<FEWSHOTS>>", fewshotBlock).replace(
      "<<TRANSCRIPT>>",
      transcriptToText(trace)
    );
    const out = await chat([{ role: "user", content: prompt }], JUDGE_MODEL, { temperature: 0 });
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (m) {
        return JSON.parse(m[0]);
      }
      return { verdict: "PARSE_ERROR", critique: out.slice(0, 80) };
    } catch (e: any) {
      return { verdict: "PARSE_ERROR", critique: String(e.message || e).slice(0, 80) };
    }
  };
}

// ----------------------------------------------------------------------------
// 3.9 — Error Analysis & Backlog Generator
// ----------------------------------------------------------------------------

export const BACKLOG_ACTIONS: Record<string, string> = {
  hallucinated_value:
    "  - Strengthen system prompt: 'NEVER state a number unless a tool returned it.'\n  - Add a check_grounding middleware that verifies numeric claims against the transcript.",
  failed_to_clarify:
    "  - Add explicit instruction: 'If the user's request is missing a required parameter, ask before acting.'\n  - Add an ask_user tool so clarification is a first-class action.",
  skipped_tool_use:
    "  - Add a precondition middleware: 'before final_answer on factual queries, verify at least one tool was called.'\n  - Stronger few-shots showing tool use as the default path.",
  computation_error:
    "  - Add a calculator tool so the agent doesn't do arithmetic in-head.\n  - Or require the agent to show its arithmetic in the final answer for verification.",
  wrong_year:
    "  - Add a verification middleware: 'before final_answer, verify any year mentioned in the answer matches a year actually queried.'",
};

export function analyzeFailures(allTraces: EvalTrace[]): {
  categories: Record<string, number>;
  totalFails: number;
} {
  const failTraces = allTraces.filter((t) => t.ground_truth.verdict === "FAIL");
  const categories: Record<string, number> = {};

  for (const t of failTraces) {
    const crit = t.ground_truth.critique.toLowerCase();
    let cat = "other";
    if (crit.includes("hallucinat") || crit.includes("invented") || crit.includes("fabricat")) {
      cat = "hallucinated_value";
    } else if (crit.includes("ambiguous") || crit.includes("clarif") || crit.includes("arbitrar") || crit.includes("asking")) {
      cat = "failed_to_clarify";
    } else if (crit.includes("never call") || crit.includes("no tool") || crit.includes("priors only")) {
      cat = "skipped_tool_use";
    } else if (crit.includes("math") || crit.includes("arithmetic") || crit.includes("computation")) {
      cat = "computation_error";
    } else if (crit.includes("fabricated year") || crit.includes("wrong year")) {
      cat = "wrong_year";
    }
    categories[cat] = (categories[cat] || 0) + 1;
  }

  return { categories, totalFails: failTraces.length };
}

// ============================================================================
// MAIN DEMO RUNNER
// ============================================================================

/**
 * Runs the full end-to-end demonstrations mirroring Class 11 notebook.
 */
export async function runAllClass11Demos(): Promise<void> {
  console.log("================================================================================");
  console.log("CLASS 11 — HARNESS, CONTEXT, EVALS (TypeScript)");
  console.log("================================================================================\n");

  resetSandbox();

  // --- 1.1 Break demo ---
  console.log("--- 1.1: Bare agent with big log ---");
  const bigLogPath = path.join(SANDBOX, "big_log.txt");
  let logContent = "";
  for (let i = 0; i < 2500; i++) {
    if (i % 200 === 0) logContent += `line ${i}: ERROR sql connection timeout in module billing\n`;
    else if (i % 150 === 0) logContent += `line ${i}: WARN deprecated API used: df.append called by user_module\n`;
    else logContent += `line ${i}: INFO regular log line, nothing interesting here\n`;
  }
  fs.writeFileSync(bigLogPath, logContent);

  const logTask =
    "Read big_log.txt completely (use bash 'cat big_log.txt' or read_file). Then write a 3-bullet summary of the kinds of log lines present to summary.md. Finally, report what you wrote.";

  console.log("Running harness v1 (with offload middleware)...");
  const { answer: answerV1, messages: msgsV1 } = await harnessV1Agent(logTask, 8);
  console.log(`Answer:\n${answerV1}\nTokens in context: ${messagesTokens(msgsV1).toLocaleString()}\n`);

  // --- 3.0 Evals demo with synthetic & live traces ---
  console.log("--- 3.0: Evals & Judge calibration ---");
  console.log("Generating trace set (combining synthetic bad + rubric)...");

  const traces: EvalTrace[] = [...BAD_TRANSCRIPTS];
  // Add simulated or live rubric traces
  for (let idx = 0; idx < Math.min(EVAL_QUERIES.length, 5); idx++) {
    const [q, tag] = EVAL_QUERIES[idx];
    const { answer, transcript } = await researchAgent(q, RESEARCH_TOOLS, 6);
    traces.push({
      i: idx,
      query: q,
      tag,
      answer,
      transcript,
      ground_truth: GROUND_TRUTH_RUBRIC[idx] || { verdict: "PASS", critique: "Correct execution" },
    });
  }

  const { train, dev, test } = splitTraces(traces);
  console.log("\nData Splits:");
  console.log(splitSummary("TRAIN", train));
  console.log(splitSummary("DEV", dev));
  console.log(splitSummary("TEST", test));

  console.log("\nEvaluating Judge v1 (Baseline without few-shot) on DEV...");
  const resDevV1 = await evaluateJudge(judgeV1, dev);
  console.log(`Judge v1 DEV Accuracy: ${(resDevV1.accuracy * 100).toFixed(1)}% | TPR: ${(resDevV1.tpr * 100).toFixed(1)}% | TNR: ${(resDevV1.tnr * 100).toFixed(1)}%`);

  console.log("\nEvaluating Judge v2 (Calibrated with few-shots) on DEV...");
  const judgeV2 = createJudgeV2(train);
  const resDevV2 = await evaluateJudge(judgeV2, dev);
  console.log(`Judge v2 DEV Accuracy: ${(resDevV2.accuracy * 100).toFixed(1)}% | TPR: ${(resDevV2.tpr * 100).toFixed(1)}% | TNR: ${(resDevV2.tnr * 100).toFixed(1)}%`);

  console.log("\nEvaluating Judge v2 on held-out TEST...");
  const resTest = await evaluateJudge(judgeV2, test);
  console.log(`Judge v2 TEST Accuracy: ${(resTest.accuracy * 100).toFixed(1)}% | TPR: ${(resTest.tpr * 100).toFixed(1)}% | TNR: ${(resTest.tnr * 100).toFixed(1)}%`);

  console.log("\nError Analysis & Flywheel Backlog:");
  const analysis = analyzeFailures(traces);
  console.log(`Total Failures Analyzed: ${analysis.totalFails}`);
  for (const [cat, count] of Object.entries(analysis.categories)) {
    console.log(`\nFailure Mode: ${cat} (${count} cases)`);
    console.log(BACKLOG_ACTIONS[cat] || "  - Investigate further.");
  }
}
