// Spawns the package entry point — `bin/pi-scholar-mcp.mjs serve` — rather than
// src/server.mjs, and requires a full MCP handshake through it.
//
// This exists because the bin entry once imported "./server.mjs", which resolves
// against bin/ while the server lives in src/. Every other test spawned
// src/server.mjs directly and stayed green, so the published package was broken
// for anyone who actually installed it. Testing the entry the clients exec is
// the only way to catch that class of bug.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-stdio.mjs";
import { resolveDist } from "./resolve-dist.mjs";

const binPath = fileURLToPath(new URL("../bin/pi-scholar-mcp.mjs", import.meta.url));
const dist = resolveDist();

const vault = mkdtempSync(join(tmpdir(), "pi-scholar-entry-vault-"));

const initProcess = spawnSync(process.execPath, [join(dist, "cli.js"), "init", vault], { stdio: "ignore" });
if (initProcess.status !== 0) {
  console.error("vault init failed");
  process.exit(1);
}

// No subcommand at all: the default is `serve`, which is what a client spawning
// the bin with no arguments gets.
const session = connect(process.execPath, [binPath], {
  env: { PI_SCHOLAR_VAULT: vault },
  timeoutMs: 180000,
});

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures += 1;
};

try {
  await session.initialize({ name: "pi-scholar-entry-test", version: "1" });
  check(true, "bin entry answers initialize with no subcommand");

  const tools = await session.request("tools/list", {});
  const names = (tools.result?.tools ?? []).map((tool) => tool.name);
  check(names.length > 0, `tools/list returns ${names.length} tools`);
  check(names.every((name) => name.startsWith("scholar_")), `every tool is namespaced scholar_*`);

  const status = await session.call("scholar_status", {});
  check(!status.isError, "scholar_status works through the bin entry");

  const stderr = session.stderr();
  check(!stderr.includes("ERR_MODULE_NOT_FOUND"), "no module-resolution error on stderr");
  if (stderr.includes("ERR_MODULE_NOT_FOUND")) {
    console.error(stderr.slice(0, 600));
  }
} catch (error) {
  check(false, `bin entry handshake: ${error.message}`);
  const stderr = session.stderr();
  if (stderr.trim() !== "") console.error(stderr.slice(0, 800));
} finally {
  session.close();
  rmSync(vault, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nBIN ENTRY CHECK PASSED" : `\n${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
