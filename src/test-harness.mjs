// Shared harness for the test scripts: spins up the MCP server against a
// throwaway vault so the tests never touch a real one.
//
//   const harness = await startHarness();
//   const result = await harness.call("scholar_status", {});
//   harness.close();

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-stdio.mjs";
import { resolveDist } from "./resolve-dist.mjs";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

export async function startHarness({ keep = false } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "pi-scholar-test-vault-"));

  const dist = resolveDist();
  const init = spawn(process.execPath, [join(dist, "cli.js"), "init", vault], { stdio: "ignore" });
  const initCode = await new Promise((resolve) => init.on("close", resolve));
  if (initCode !== 0) throw new Error(`vault init failed with code ${initCode}`);

  const session = connect(process.execPath, [serverPath], {
    env: { PI_SCHOLAR_VAULT: vault },
    timeoutMs: 180000,
  });
  await session.initialize({ name: "pi-scholar-mcp-tests", version: "1" });

  return {
    vault,
    call: session.call,
    stderr: session.stderr,
    close() {
      session.close();
      if (!keep) rmSync(vault, { recursive: true, force: true });
    },
  };
}
