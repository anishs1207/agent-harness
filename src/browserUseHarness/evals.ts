import { BrowserSession } from "./index.js";
import {
    createContext,
    createTools,
    defaultGuardrails,
    runLoop,
    type LoopResult,
} from "../index.js";

type ModelEval = {
    level: number;
    id: string;
    description: string;
    task: string;
    html: string;
    verify: (session: BrowserSession, result: LoopResult) => Promise<string>;
};

type EvalResult = {
    level: number;
    id: string;
    passed: boolean;
    durationMs: number;
    iterations: number;
    toolsUsed: string[];
    answer: string;
    evidence?: string;
    error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function state<T>(session: BrowserSession, expression: string): Promise<T> {
    const raw = await session.evaluate(expression);
    return JSON.parse(raw.slice("Result: ".length)) as T;
}

// These are end-to-end model evals. Keep passing cases and append harder cases.
export const browserEvals: ModelEval[] = [
    {
        level: 1,
        id: "01-observe-and-report",
        description: "Read the live page and report exact information",
        task: "The page is already open. Report the account owner and current plan. Inspect the page with browser tools; do not guess.",
        html: `<!doctype html><title>Account</title><main><h1>Account overview</h1><dl><dt>Owner</dt><dd>Ada Lovelace</dd><dt>Plan</dt><dd>Research Pro</dd></dl></main>`,
        verify: async (_session, result) => {
            assert(/Ada Lovelace/i.test(result.answer), "answer omitted the account owner");
            assert(/Research Pro/i.test(result.answer), "answer omitted the current plan");
            assert(result.trace.some((step) => step.toolEvents.some((event) => ["browser_snapshot", "browser_get_text"].includes(event.tool))), "model answered without observing the page");
            return "answer contains both exact page values after observation";
        },
    },
    {
        level: 2,
        id: "02-labelled-form",
        description: "Fill and submit a form using accessible controls",
        task: "The page is already open. Set Work email to ada@example.test, submit the form, and verify that the page confirms the saved email.",
        html: `<!doctype html><main><h1>Profile</h1><label for="email">Work email</label><input id="email" type="email"><button onclick="const o=document.querySelector('output');o.textContent='Saved '+document.querySelector('#email').value;o.dataset.saved='true'">Save profile</button><output role="status" data-saved="false"></output></main>`,
        verify: async (session) => {
            const result = await state<{ value: string; saved: string; text: string }>(session, `(()=>{const i=document.querySelector('#email'),o=document.querySelector('output');return {value:i.value,saved:o.dataset.saved,text:o.textContent}})()`);
            assert(result.value === "ada@example.test", "email field has the wrong value");
            assert(result.saved === "true" && result.text === "Saved ada@example.test", "form was not successfully submitted");
            return JSON.stringify(result);
        },
    },
    {
        level: 3,
        id: "03-async-verification",
        description: "Wait for and verify an asynchronous state transition",
        task: "The page is already open. Start the import and do not finish until you have verified that its state is Complete.",
        html: `<!doctype html><main><h1>Importer</h1><button onclick="this.disabled=true;setTimeout(()=>{const s=document.querySelector('#status');s.textContent='Complete';s.dataset.state='complete'},500)">Start import</button><p id="status" role="status" data-state="idle">Idle</p></main>`,
        verify: async (session) => {
            const result = await state<{ state: string; text: string }>(session, `(()=>{const s=document.querySelector('#status');return {state:s.dataset.state,text:s.textContent}})()`);
            assert(result.state === "complete" && result.text === "Complete", "model did not wait for completion");
            return JSON.stringify(result);
        },
    },
    {
        level: 4,
        id: "04-validation-recovery",
        description: "Recover from validation and complete a multi-field form",
        task: "The page is already open. Create project Orion in Asia Pacific. If the UI reports a problem, fix it. Verify the final success message before finishing.",
        html: `<!doctype html><main><h1>New project</h1><label>Project name <input id="project"></label><label>Region <select id="region"><option value="">Choose</option><option value="eu">Europe</option><option value="ap">Asia Pacific</option></select></label><button onclick="const p=document.querySelector('#project'),r=document.querySelector('#region'),o=document.querySelector('#result');o.textContent=p.value&&r.value?'Created '+p.value+' in '+r.selectedOptions[0].text:'Complete all required fields';o.dataset.ok=String(Boolean(p.value&&r.value))">Create project</button><p id="result" role="alert" data-ok="false"></p></main>`,
        verify: async (session) => {
            const result = await state<{ name: string; region: string; ok: string; text: string }>(session, `(()=>{const p=document.querySelector('#project'),r=document.querySelector('#region'),o=document.querySelector('#result');return {name:p.value,region:r.value,ok:o.dataset.ok,text:o.textContent}})()`);
            assert(result.name === "Orion" && result.region === "ap", "required form values are incorrect");
            assert(result.ok === "true" && result.text === "Created Orion in Asia Pacific", "project creation was not verified");
            return JSON.stringify(result);
        },
    },
    {
        level: 5,
        id: "05-ambiguous-table-action",
        description: "Find the correct row among duplicate action labels",
        task: "The page is already open. Filter for order B-42, open that exact order (not another row), and verify the details dialog shows B-42 belonging to Mira.",
        html: `<!doctype html><main><h1>Orders</h1><label for="query">Filter orders</label><input id="query" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.innerText.toLowerCase().includes(this.value.toLowerCase())"><table><tbody><tr data-id="A-17"><td>A-17</td><td>Lin</td><td><button onclick="pick(this)">Open</button></td></tr><tr data-id="B-42"><td>B-42</td><td>Mira</td><td><button onclick="pick(this)">Open</button></td></tr><tr data-id="C-09"><td>C-09</td><td>Noor</td><td><button onclick="pick(this)">Open</button></td></tr></tbody></table><dialog><h2>Order details</h2><p id="chosen"></p><button onclick="this.closest('dialog').close()">Close</button></dialog><script>function pick(b){const r=b.closest('tr');document.querySelector('#chosen').textContent=r.dataset.id+' / '+r.cells[1].textContent;document.querySelector('dialog').showModal()}</script></main>`,
        verify: async (session) => {
            const result = await state<{ filter: string; open: boolean; chosen: string }>(session, `(()=>({filter:document.querySelector('#query').value,open:document.querySelector('dialog').open,chosen:document.querySelector('#chosen').textContent}))()`);
            assert(result.filter === "B-42", "model did not apply the requested filter");
            assert(result.open && result.chosen === "B-42 / Mira", "model opened the wrong order or failed to verify it");
            return JSON.stringify(result);
        },
    },
    {
        level: 6,
        id: "06-dependent-confirmation-workflow",
        description: "Handle delayed dependent controls and a confirmation dialog",
        task: "The page is already open. Queue a deployment to API cluster 7 in Production. Handle controls that load asynchronously, confirm the deployment, and verify the final queued state.",
        html: `<!doctype html><main><h1>Deployment</h1><label>Environment <select id="env" onchange="loadTargets()"><option value="">Choose</option><option value="staging">Staging</option><option value="prod">Production</option></select></label><label>Target <select id="target" disabled><option>Loading</option></select></label><button id="deploy" disabled onclick="document.querySelector('dialog').showModal()">Deploy</button><dialog><p id="confirm-copy"></p><button onclick="confirmDeploy()">Confirm deployment</button><button onclick="this.closest('dialog').close()">Cancel</button></dialog><p id="status" role="status" data-state="idle">Not started</p><script>function loadTargets(){const e=document.querySelector('#env'),t=document.querySelector('#target');t.disabled=true;setTimeout(()=>{t.innerHTML=e.value==='prod'?'<option value="">Choose</option><option value="api-7">API cluster 7</option><option value="web-2">Web cluster 2</option>':'<option value="stage-1">Stage cluster 1</option>';t.disabled=false;t.onchange=()=>{document.querySelector('#deploy').disabled=!t.value;document.querySelector('#confirm-copy').textContent='Deploy '+t.selectedOptions[0].text+' to '+e.selectedOptions[0].text+'?'}},500)}function confirmDeploy(){document.querySelector('dialog').close();setTimeout(()=>{const s=document.querySelector('#status');s.textContent='Deployment queued: api-7 / Production';s.dataset.state='queued'},500)}</script></main>`,
        verify: async (session) => {
            const result = await state<{ environment: string; target: string; state: string; text: string }>(session, `(()=>({environment:document.querySelector('#env').value,target:document.querySelector('#target').value,state:document.querySelector('#status').dataset.state,text:document.querySelector('#status').textContent}))()`);
            assert(result.environment === "prod" && result.target === "api-7", "dependent selections are incorrect");
            assert(result.state === "queued" && result.text === "Deployment queued: api-7 / Production", "deployment did not reach the verified queued state");
            return JSON.stringify(result);
        },
    },
];

async function runEval(test: ModelEval, model: string): Promise<EvalResult> {
    const started = Date.now();
    const session = new BrowserSession();
    let loopResult: LoopResult | undefined;
    try {
        await session.open({ headless: true });
        await session.setContent(test.html);
        loopResult = await runLoop(model, createContext(test.task), defaultGuardrails, createTools(session));
        const evidence = await test.verify(session, loopResult);
        const toolsUsed = loopResult.trace.flatMap((step) => step.toolEvents.map((event) => event.tool));
        assert(toolsUsed.length > 0, "model completed without using browser tools");
        return { level: test.level, id: test.id, passed: true, durationMs: Date.now() - started, iterations: loopResult.iterations, toolsUsed, answer: loopResult.answer, evidence };
    } catch (error) {
        return {
            level: test.level,
            id: test.id,
            passed: false,
            durationMs: Date.now() - started,
            iterations: loopResult?.iterations ?? 0,
            toolsUsed: loopResult?.trace.flatMap((step) => step.toolEvents.map((event) => event.tool)) ?? [],
            answer: loopResult?.answer ?? "",
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        await session.close();
    }
}

export async function runBrowserEvals(
    model = process.env.MODEL || "claude-sonnet-4-6",
    selectedIds: string[] = []
): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    const selected = selectedIds.length === 0
        ? browserEvals
        : browserEvals.filter((test) => selectedIds.includes(test.id));
    assert(selected.length > 0, `no eval matched: ${selectedIds.join(", ")}`);
    console.log(`Running end-to-end headless browser evals with ${model}\n`);
    for (const test of selected) {
        console.log(`[level ${test.level}] ${test.id}: ${test.description}`);
        const result = await runEval(test, model);
        results.push(result);
        console.log(result.passed
            ? `  PASS (${result.durationMs}ms, ${result.iterations} iterations, ${result.toolsUsed.length} tool calls)\n`
            : `  FAIL (${result.error})\n`);
    }
    return results;
}

async function main(): Promise<void> {
    const results = await runBrowserEvals(process.env.MODEL || "claude-sonnet-4-6", process.argv.slice(2));
    const passed = results.filter((result) => result.passed).length;
    console.log(`Model browser evals: ${passed}/${results.length} passed`);
    for (const result of results.filter((item) => !item.passed)) console.log(`- ${result.id}: ${result.error}`);
    if (passed !== results.length) process.exitCode = 1;
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("/browserUseHarness/evals.js");
if (isDirectRun) main().catch((error) => { console.error(error); process.exitCode = 1; });
