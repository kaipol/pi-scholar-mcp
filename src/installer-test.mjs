// Installer contract test: runs the real CLI against a throwaway HOME and
// asserts the invariants that are easy to get wrong — the vault must reach the
// config, existing servers must survive a merge, a re-run must not rewrite a
// correct entry, and a changed --vault must update it in place rather than
// appending a second definition.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../bin/pi-scholar-mcp.mjs", import.meta.url));

function skillNames(dir) {
  try {
    return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")));
  } catch {
    return [];
  }
}

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "pi-scholar-installer-home-"));
for (const dir of [".zcode/cli", ".claude", ".codex"]) mkdirSync(join(home, dir), { recursive: true });

const fakeWindowsHome = join(home).replace(/\//g, "\\");
const env = { ...process.env, HOME: home, USERPROFILE: fakeWindowsHome };

// Pre-existing configuration that the merge must not damage.
writeFileSync(
  join(home, ".zcode", "cli", "config.json"),
  JSON.stringify({ mcp: { servers: { exa: { type: "http", url: "https://mcp.exa.ai/mcp" } } }, theme: "dark" }, null, 2),
);
writeFileSync(
  join(home, ".codex", "config.toml"),
  ['model = "gpt-5-codex"', "", "[mcp_servers.exa]", 'url = "https://mcp.exa.ai/mcp"', 'type = "http"', ""].join("\n"),
);

function install(...args) {
  const result = spawnSync(process.execPath, [cli, "install", "--target", "zcode,codex", ...args], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`install failed: ${result.stderr}`);
  return result.stdout;
}

const vaultA = join(home, "vaultA");
const vaultB = join(home, "vaultB");

install("--vault", vaultA);

const zcodeConfig = () => JSON.parse(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8"));
const codexConfig = () => readFileSync(join(home, ".codex", "config.toml"), "utf8");

check(
  zcodeConfig().mcp.servers["pi-scholar"].env.PI_SCHOLAR_VAULT === vaultA,
  "the requested vault reaches the ZCode config",
);
// Codex takes TOML, so a Windows path is written with doubled backslashes; that
// escaping is the contract, and it has to round-trip back to the raw path.
const tomlEscape = (value) => value.replace(/\\/g, "\\\\");
check(codexConfig().includes(`PI_SCHOLAR_VAULT = "${tomlEscape(vaultA)}"`), "the requested vault reaches the Codex config");
check(zcodeConfig().mcp.servers.exa !== undefined, "a pre-existing ZCode server survives the merge");
check(zcodeConfig().theme === "dark", "unrelated ZCode keys survive the merge");
check(codexConfig().includes("[mcp_servers.exa]"), "a pre-existing Codex server survives the merge");
check(codexConfig().includes('model = "gpt-5-codex"'), "unrelated Codex keys survive the merge");

const skills = [".agents", ".claude", ".codex"].map((dir) => join(home, dir, "skills"));
check(skillNames(skills[0]).length === 5, "the five skills land in the skill directory", `${skills[0]} (${skillNames(skills[0]).join(", ")})`);

const before = readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8");
install("--vault", vaultA);
check(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8") === before, "a re-run with the same vault does not rewrite the config");

install("--vault", vaultB);
check(zcodeConfig().mcp.servers["pi-scholar"].env.PI_SCHOLAR_VAULT === vaultB, "a re-run with a new vault updates the config");
const codexText = codexConfig();
check(
  codexText.split("[mcp_servers.pi-scholar]").length - 1 === 1 && codexText.split("[mcp_servers.pi-scholar.env]").length - 1 === 1,
  "the Codex table is replaced, not duplicated",
);

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nINSTALLER TEST PASSED" : `\n${failures} installer check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
