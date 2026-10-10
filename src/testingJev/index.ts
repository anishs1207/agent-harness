import dotenv from "dotenv";
import { JevClient } from "./client.js";
import { JevPermissionGate } from "./permission-gate.js";

dotenv.config({ quiet: true });
export * from "./client.js";
export * from "./permission-gate.js";
export type * from "./types.js";

async function main(): Promise<void> {
    const raw = process.argv[2];
    if (!raw || process.argv.includes("--help")) {
        console.log(`Usage: npm run jev -- '{"userRequest":"Fix the tests","tool":"run_command","arguments":{"command":"npm test"}}'`);
        return;
    }
    const gate = new JevPermissionGate(new JevClient());
    const result = await gate.assess(JSON.parse(raw));
    console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("/testingJev/index.js");
if (isDirectRun) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
