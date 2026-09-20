// The MCP clients this package can configure.
//
// There is exactly one server (src/server.mjs) and one set of skills (skills/).
// What differs per client is only where that client reads its skill documents
// from and where it stores its MCP server table. Every format below was checked
// against a real installation rather than assumed: ZCode keeps its table under
// `mcp.servers` in ~/.zcode/cli/config.json, Claude Code under `mcpServers` in
// ~/.claude.json, and Codex under `[mcp_servers]` in ~/.codex/config.toml.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SERVER_NAME = "pi-scholar";
const HOME = homedir();

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The inverse of tomlString for the one value we read back: a Windows path is
// written with doubled backslashes, and reading it without unescaping would
// make a correct config look like it points somewhere else.
function tomlUnescape(value) {
  return value.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function vaultDefault() {
  return process.env.PI_SCHOLAR_VAULT ?? join(HOME, "pi-scholar-vault");
}

export function clients() {
  return [
    {
      id: "zcode",
      label: "ZCode",
      home: join(HOME, ".zcode"),
      // ZCode scans ~/.agents/skills as well as ~/.zcode/skills, so installing
      // into the shared .agents location leaves one copy instead of two.
      skillsDir: join(HOME, ".agents", "skills"),
      configPath: join(HOME, ".zcode", "cli", "config.json"),
      configKind: "nested-json",
      entry(vault = vaultDefault()) {
        return {
          type: "stdio",
          command: "npx",
          args: ["-y", "pi-scholar-mcp@latest"],
          env: { PI_SCHOLAR_VAULT: vault },
          enabled: true,
        };
      },
    },
    {
      id: "claude",
      label: "Claude Code",
      home: join(HOME, ".claude"),
      skillsDir: join(HOME, ".claude", "skills"),
      configPath: join(HOME, ".claude.json"),
      configKind: "flat-json",
      entry(vault = vaultDefault()) {
        return {
          command: "npx",
          args: ["-y", "pi-scholar-mcp@latest"],
          env: { PI_SCHOLAR_VAULT: vault },
        };
      },
    },
    {
      id: "codex",
      label: "Codex",
      home: join(HOME, ".codex"),
      skillsDir: join(HOME, ".codex", "skills"),
      configPath: join(HOME, ".codex", "config.toml"),
      configKind: "toml",
      entry(vault = vaultDefault()) {
        return {
          command: "npx",
          args: ["-y", "pi-scholar-mcp@latest"],
          env: { PI_SCHOLAR_VAULT: vault },
        };
      },
    },
  ];
}

export function resolveTargets(requested) {
  const all = clients();
  if (!requested || requested === "auto") {
    return all.filter((client) => existsSync(client.home));
  }
  const wanted = requested.split(",").map((part) => part.trim()).filter(Boolean);
  if (wanted.includes("all")) return all;
  const unknown = wanted.filter((id) => !all.some((client) => client.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown target(s): ${unknown.join(", ")}. Known targets: ${all.map((c) => c.id).join(", ")}, all, auto`,
    );
  }
  return all.filter((client) => wanted.includes(client.id));
}

// ---------------------------------------------------------------------------
// Config writing. Each kind is written in place with a timestamped backup, so
// a failed merge never costs the user their existing client configuration.
// ---------------------------------------------------------------------------

function readJsonConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error.message}); edit it by hand`);
  }
}

function setPath(root, keyPath, value) {
  let node = root;
  for (const key of keyPath.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

export function configHasServer(client) {
  const entry = readServerEntry(client);
  return entry !== undefined;
}

// The vault a client's existing entry points at, or undefined when there is no
// entry. Doctor compares this against the vault it is checking, which catches a
// config written before the operator passed a different --vault.
export function configuredVault(client) {
  const entry = readServerEntry(client);
  if (entry === undefined) return undefined;
  return entry.env?.PI_SCHOLAR_VAULT;
}

// The full entry a client stores — command, args, vault — for whichever client
// is configured first. Doctor uses this to spawn exactly what the clients will
// spawn, so a package whose bin entry is broken fails the check instead of
// looking healthy because src/server.mjs still runs.
export function configuredEntry() {
  for (const client of clients()) {
    const entry = readServerEntry(client);
    if (entry !== undefined && entry.command !== undefined) return entry;
  }
  return undefined;
}

// Reads back the identity of an existing entry — command, args, and vault — in
// whichever shape the client stores it. Only these three fields are compared,
// because a hand-configured entry may legitimately carry extras (`type`,
// `enabled`, timeouts) that this package never sets.
function readServerEntry(client) {
  if (!existsSync(client.configPath)) return undefined;
  if (client.configKind === "toml") {
    const text = readFileSync(client.configPath, "utf8");
    const span = tomlTableSpan(text, `mcp_servers.${SERVER_NAME}`);
    if (span === undefined) return undefined;
    const body = span.lines.slice(span.start, span.end).join("\n");
    const command = body.match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    const argsLine = body.match(/^\s*args\s*=\s*\[(.*)\]/m);
    const vault = body.match(/^\s*PI_SCHOLAR_VAULT\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    const args = argsLine ? [...argsLine[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => tomlUnescape(match[1])) : undefined;
    return {
      command: command ? tomlUnescape(command[1]) : undefined,
      args,
      env: vault ? { PI_SCHOLAR_VAULT: tomlUnescape(vault[1]) } : undefined,
    };
  }
  let node = readJsonConfig(client.configPath);
  for (const key of client.configKind === "nested-json" ? ["mcp", "servers", SERVER_NAME] : ["mcpServers", SERVER_NAME]) {
    node = node?.[key];
    if (node === undefined) return undefined;
  }
  return { command: node.command, args: node.args, env: node.env };
}

// A path is the same path whether it was typed with forward or backward
// slashes, and JSON.stringify keeps whichever the caller passed, so every vault
// comparison goes through here rather than comparing raw strings.
export function samePath(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return resolve(a) === resolve(b);
}

function sameEntry(existing, wanted) {
  return (
    existing.command === wanted.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(wanted.args ?? []) &&
    samePath(existing.env?.PI_SCHOLAR_VAULT, wanted.env?.PI_SCHOLAR_VAULT)
  );
}

// The span of one TOML table including its sub-tables. `[mcp_servers.x]` runs
// until the next header that is not `[mcp_servers.x.<something>]`; without the
// sub-table rule a replacement would stop at `.env` and leave a stale copy.
function tomlTableSpan(text, table) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return undefined;
  const subPrefix = `[${table}.`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index]) && !lines[index].trim().startsWith(subPrefix)) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
}

export function tomlBlock(entry) {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    "enabled = true",
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 120",
    "",
    `[mcp_servers.${SERVER_NAME}.env]`,
  ];
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeConfig(client, entry) {
  const existing = readServerEntry(client);
  // Leave a correct entry alone: rewriting it would churn the backup and
  // destroy the one copy of the user's pre-install configuration. An entry that
  // differs — a different vault, or a switch between the published package and
  // a working copy — is stale and gets updated.
  if (existing !== undefined && sameEntry(existing, entry)) {
    return { written: false, path: client.configPath, reason: "already configured" };
  }

  const { configPath, configKind } = client;
  let next;

  if (configKind === "toml") {
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const block = tomlBlock(entry);
    if (existing === undefined) {
      const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      next = `${current}${prefix}\n${block}`;
    } else {
      const span = tomlTableSpan(current, `mcp_servers.${SERVER_NAME}`);
      if (span === undefined) throw new Error(`could not find the ${SERVER_NAME} table to replace in ${configPath}`);
      const { lines, start, end } = span;
      next = [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
    }
  } else {
    const parsed = readJsonConfig(configPath);
    setPath(parsed, configKind === "nested-json" ? ["mcp", "servers", SERVER_NAME] : ["mcpServers", SERVER_NAME], entry);
    next = `${JSON.stringify(parsed, null, 2)}\n`;
  }

  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    throw new Error(`${dir} does not exist; start ${client.label} once so it creates its config directory`);
  }
  if (existsSync(configPath)) {
    writeFileSync(`${configPath}.pi-scholar-backup`, readFileSync(configPath));
  }
  writeFileSync(configPath, next);
  return { written: true, path: configPath };
}
