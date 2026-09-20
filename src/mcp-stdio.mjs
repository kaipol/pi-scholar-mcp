// A minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over a child's
// stdin/stdout, with logs going to the child's stderr. Shared by the test
// harness and by `doctor`, so both speak to the bridge exactly the way a real
// MCP client does.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const PROTOCOL_VERSION = "2024-11-05";

// On Windows the npm shims (`npx`, `npm`) are `.cmd` files, and Node refuses to
// exec a `.cmd` without a shell (and a bare `npx` is not found at all). Real MCP
// clients work around this by going through `cmd /c`; this client does the same,
// so what it spawns is what they spawn. Elsewhere the command is used verbatim.
function spawnCommand(command, args, options) {
  if (process.platform !== "win32") return spawn(command, args, options);

  const hasExtension = /\.[A-Za-z0-9]+$/.test(command);
  if (hasExtension) return spawn(command, args, options);

  const found = (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (dir === "") return false;
    return [".cmd", ".exe", ".bat"].some((ext) => existsSync(join(dir, command + ext)));
  });
  if (!found) return spawn(command, args, options);

  return spawn("cmd", ["/d", "/s", "/c", command, ...args], options);
}

export function connect(command, args, { env, cwd, stdio, timeoutMs = 180000 } = {}) {
  const child = spawnCommand(command, args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: stdio ?? ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a log line that leaked onto stdout is not ours to parse
      }
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });

  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async function call(name, args) {
    const response = await request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    const text = response.result?.content?.map((entry) => entry.text).join("") ?? "";
    return { isError: Boolean(response.result?.isError), text, json: () => JSON.parse(text) };
  }

  async function initialize(clientInfo) {
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: clientInfo ?? { name: "pi-scholar-mcp", version: "1" },
    });
  }

  return {
    child,
    call,
    request,
    initialize,
    stderr: () => stderrChunks.join(""),
    close() {
      child.kill();
    },
  };
}
