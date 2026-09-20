#!/usr/bin/env node
// pi-scholar-mcp command line.
//
//   pi-scholar-mcp                       start the MCP stdio server (default)
//   pi-scholar-mcp install               configure every MCP client on this machine
//   pi-scholar-mcp install --target codex   configure one client
//   pi-scholar-mcp install --print       print the config instead of writing it
//   pi-scholar-mcp doctor                check the installation end to end
//   pi-scholar-mcp vault <path>          initialise a vault at <path>
//
// `serve` is what an MCP client spawns; everything else is one-shot setup. The
// server speaks plain MCP over stdio, so any MCP client can drive it — the
// per-client differences live in src/mcp-clients.mjs.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "../src/mcp-stdio.mjs";
import { clients, configHasServer, configuredEntry, configuredVault, resolveTargets, samePath, SERVER_NAME, tomlBlock, vaultDefault, writeConfig } from "../src/mcp-clients.mjs";
import { resolveDist } from "../src/resolve-dist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const skillsRoot = join(packageRoot, "skills");

const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
  process.stderr.write(`pi-scholar-mcp: ${message}\n`);
  process.exit(1);
};

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "usage: pi-scholar-mcp [command] [options]",
    "",
    "commands:",
    "  serve                 start the MCP stdio server (default)",
    "  install               configure MCP clients and install the skills",
    "  doctor                check the installation end to end",
    "  vault <path>          initialise a vault at <path>",
    "",
    "install options:",
    "  --target <list>       comma-separated client ids, or 'all' / 'auto' (default: auto)",
    "  --vault <path>        vault to point the clients at",
    "  --from <spec>         npx spec to run instead of the published package",
    "  --local               run this checkout instead of the published package",
    "  --print               show the configuration instead of writing it",
    "",
    "doctor options:",
    "  --target <list>       comma-separated client ids, or 'all' / 'auto' (default: auto)",
    "  --vault <path>        vault to check",
    "  --remote              also fetch and run the package the clients run (slow: needs the network)",
  ].join("\n");
}

// The default entry runs the published package through npx, which is what makes
// the setup independent of any local files. --from swaps the npx spec for
// another source (a GitHub repo before the package is on npm, say), and --local
// points the clients at this checkout instead, for work on the bridge itself.
function entryFor(client, vault) {
  const entry = client.entry(vault);
  if (hasFlag("--local")) {
    return { ...entry, command: process.execPath, args: [join(packageRoot, "bin", "pi-scholar-mcp.mjs")] };
  }
  const from = flagValue("--from");
  if (from) return { ...entry, command: "npx", args: ["-y", from] };
  return entry;
}

function piScholarCli(args, options = {}) {
  const dist = resolveDist();
  return spawnSync(process.execPath, [join(dist, "cli.js"), ...args], { stdio: "inherit", ...options });
}

function installSkills(skillsDir) {
  const installed = [];
  for (const entry of readdirSync(skillsRoot)) {
    const source = join(skillsRoot, entry, "SKILL.md");
    if (!existsSync(source)) continue;
    const target = join(skillsDir, entry);
    mkdirSync(target, { recursive: true });
    copyFileSync(source, join(target, "SKILL.md"));
    installed.push(entry);
  }
  return installed;
}

function commandInstall() {
  const vault = flagValue("--vault") ?? vaultDefault();
  let targets;
  try {
    targets = resolveTargets(flagValue("--target"));
  } catch (error) {
    fail(error.message);
  }
  if (targets.length === 0) {
    fail(
      "no MCP client found on this machine. Pass --target explicitly " +
        `(${clients().map((c) => c.id).join(", ")}) or add the server to your client's MCP configuration by hand.`,
    );
  }

  if (hasFlag("--print")) {
    for (const client of targets) {
      log(`--- ${client.label} (${client.configPath}) ---`);
      const entry = entryFor(client, vault);
      log(client.configKind === "toml" ? tomlBlock(entry) : JSON.stringify(entry, null, 2));
      log("");
    }
    return;
  }

  log(`Vault: ${vault}`);
  if (!existsSync(join(vault, ".pi-scholar", "vault.json"))) {
    log("Initialising vault...");
    const result = piScholarCli(["init", vault]);
    if (result.status !== 0) fail("vault initialisation failed");
  }

  for (const client of targets) {
    log("");
    log(`== ${client.label}`);
    const installed = installSkills(client.skillsDir);
    log(`  skills -> ${client.skillsDir} (${installed.length})`);
    try {
      const outcome = writeConfig(client, entryFor(client, vault));
      log(outcome.written ? `  config -> ${outcome.path}` : `  config: ${outcome.reason}`);
    } catch (error) {
      log(`  config: ${error.message}`);
    }
  }

  log("");
  log("Restart the clients you configured: MCP server changes only take effect on a new session.");
  log(`Run \`pi-scholar-mcp doctor --target ${targets.map((t) => t.id).join(",")}\` to verify.`);
}

function commandVault(path) {
  if (!path || path.startsWith("--")) fail(`usage: pi-scholar-mcp vault <path>\n\n${usage()}`);
  const result = piScholarCli(["init", path]);
  if (result.status !== 0) fail("vault initialisation failed");
}

async function handshake(command, args, vault, label) {
  const session = connect(command, args, {
    env: { PI_SCHOLAR_VAULT: vault },
    timeoutMs: 180000,
  });
  try {
    await session.initialize({ name: "pi-scholar-mcp-doctor", version: "1" });
    const tools = await session.request("tools/list", {});
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    return { label, names };
  } finally {
    session.close();
  }
}

// Spawning src/server.mjs directly would prove the server works but say nothing
// about the bin entry the clients actually exec — and that entry is where a
// wrong relative import hides, invisible to every other test in the suite.
async function handshakeBin(vault) {
  return handshake(
    process.execPath,
    [join(packageRoot, "bin", "pi-scholar-mcp.mjs"), "serve", "--vault", vault],
    vault,
    "bin entry (pi-scholar-mcp serve)",
  );
}

async function handshakeRemote(vault) {
  // Whatever the clients are actually configured to run: npx from GitHub today,
  // npm once the package is published. Re-reading it from the live config keeps
  // this honest instead of testing a command nobody uses.
  const configured = configuredEntry();
  if (configured === undefined) {
    return { label: "remote entry", names: [], skipped: "no client has a configured entry yet" };
  }
  return handshake(configured.command, configured.args ?? [], vault, `remote entry (${configured.command} ${(configured.args ?? []).join(" ")})`);
}

async function commandDoctor() {
  let problems = 0;
  const check = (ok, message) => {
    log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) problems += 1;
  };

  let dist;
  try {
    dist = resolveDist();
    check(true, `pi-scholar runtime: ${dist}`);
  } catch (error) {
    check(false, `pi-scholar runtime: ${error.message}`);
  }

  const vault = flagValue("--vault") ?? vaultDefault();
  check(
    existsSync(join(vault, ".pi-scholar", "vault.json")),
    `vault: ${existsSync(join(vault, ".pi-scholar", "vault.json")) ? vault : `${vault} is not initialised`}`,
  );

  let targets;
  try {
    targets = resolveTargets(flagValue("--target"));
  } catch (error) {
    fail(error.message);
  }
  for (const client of targets) {
    const skills = existsSync(client.skillsDir)
      ? readdirSync(client.skillsDir).filter((name) => name.startsWith("scholar-") && existsSync(join(client.skillsDir, name, "SKILL.md")))
      : [];
    check(skills.length > 0, `${client.label} skills: ${skills.length > 0 ? skills.join(", ") : `none in ${client.skillsDir}`}`);
    if (configHasServer(client)) {
      const configured = configuredVault(client);
      const matches = samePath(configured, vault);
      check(matches, `${client.label} MCP config: ${matches ? client.configPath : `${client.configPath} points at ${configured}, not ${vault}`}`);
    } else {
      check(false, `${client.label} MCP config: no '${SERVER_NAME}' entry in ${client.configPath}`);
    }
  }

  if (dist && existsSync(join(vault, ".pi-scholar", "vault.json"))) {
    try {
      const local = await handshakeBin(vault);
      check(local.names.length > 0, `${local.label}: ${local.names.length} tools (${local.names.slice(0, 3).join(", ")}...)`);
    } catch (error) {
      check(false, `bin entry (pi-scholar-mcp serve): ${error.message}`);
    }

    // --remote spends the network round trip to fetch and run the package the
    // way the clients do. Off by default because a clean npx cache makes it slow.
    if (args.includes("--remote")) {
      try {
        const remote = await handshakeRemote(vault);
        if (remote.skipped !== undefined) {
          check(true, `${remote.label}: skipped — ${remote.skipped}`);
        } else {
          check(remote.names.length > 0, `${remote.label}: ${remote.names.length} tools`);
        }
      } catch (error) {
        check(false, `remote entry: ${error.message}`);
      }
    }
  }

  log(problems === 0 ? "\nAll checks passed." : `\n${problems} problem(s) found.`);
  process.exit(problems === 0 ? 0 : 1);
}

async function commandServe() {
  // Hand the process over to the MCP server; stdio is the protocol channel. The
  // path is resolved from this file's location rather than a relative specifier,
  // because "./server.mjs" would resolve against bin/ and the server lives in
  // src/ — which is exactly the failure the published package used to hit.
  await import(pathToFileURL(join(packageRoot, "src", "server.mjs")).href);
}

const args = process.argv.slice(2);
const [command] = args;

switch (command) {
  case undefined:
  case "serve":
    await commandServe();
    break;
  case "install":
    commandInstall();
    break;
  case "vault":
    commandVault(args[1]);
    break;
  case "doctor":
    await commandDoctor();
    break;
  case "help":
  case "--help":
  case "-h":
    log(usage());
    break;
  default:
    fail(`unknown command: ${command}\n\n${usage()}`);
}
