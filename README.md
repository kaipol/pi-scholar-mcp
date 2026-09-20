# pi-scholar-mcp

[pi-scholar](https://github.com/N-F9/pi-scholar) is a local-first sourced
Markdown wiki with a spaced-repetition daily review loop. Upstream ships it as
a Pi coding-agent extension, which means its `scholar_*` tools are only
reachable from Pi.

This package makes them reachable from **any MCP client** — ZCode, Claude Code,
Codex, or anything else that speaks the protocol — with no local checkout of
pi-scholar and no hand-placed scripts.

## The method

One package, three moving parts, and the same three parts for every client:

1. **One MCP server.** `src/server.mjs` wraps the pi-scholar application layer
   as a plain stdio MCP server. Nothing about it is client-specific: it reads
   JSON-RPC requests from stdin and writes responses to stdout, exactly as the
   protocol requires.
2. **One set of skills.** `skills/` holds five Markdown documents that tell an
   agent how to drive the tools. They are written in client-neutral terms — a
   "subagent" is whatever your client calls one, a tool namespace is whatever
   your client prefixes it with — so the same document works everywhere.
3. **One installer.** `pi-scholar-mcp install` writes the server into each MCP
   client's own configuration and drops the skills into that client's own skill
   directory.

So the only thing that varies between clients is *where* they keep their config
and skills, which is a fact about the client rather than about pi-scholar.

## Quick start

```bash
npx -y pi-scholar-mcp install
```

That command, on a machine with ZCode, Claude Code, and Codex installed, will:

- create the vault at `~/pi-scholar-vault` if it does not exist yet;
- copy the five skills into each client's skill directory;
- register the `pi-scholar` MCP server in each client's configuration, pointing
  at `npx -y pi-scholar-mcp@latest` with `PI_SCHOLAR_VAULT` set.

Restart the clients afterwards — MCP server changes only take effect on a new
session.

Then verify:

```bash
npx -y pi-scholar-mcp doctor
```

## What gets configured

Each row was checked against a real installation rather than assumed.

| Client | Skill directory | MCP configuration |
| --- | --- | --- |
| ZCode | `~/.agents/skills` | `~/.zcode/cli/config.json`, under `mcp.servers` |
| Claude Code | `~/.claude/skills` | `~/.claude.json`, under `mcpServers` |
| Codex | `~/.codex/skills` | `~/.codex/config.toml`, under `[mcp_servers]` |

ZCode scans `~/.agents/skills` as well as `~/.zcode/skills`, so the installer
uses the shared `.agents` location and leaves one copy rather than two.

Every config write is preceded by a backup at `<config>.pi-scholar-backup`, and
a client whose config already has a `pi-scholar` entry is left alone rather than
silently rewritten.

### Selecting targets

```bash
npx -y pi-scholar-mcp install --target codex          # just Codex
npx -y pi-scholar-mcp install --target zcode,claude   # two of them
npx -y pi-scholar-mcp install --target all            # force every known client
npx -y pi-scholar-mcp install --print                 # show, do not write
```

With no `--target`, the installer picks every client whose home directory
exists. `--vault <path>` points the clients somewhere other than
`~/pi-scholar-vault`.

By default the clients run the **published** package (`npx -y
pi-scholar-mcp@latest`), which is what makes the setup independent of any local
files. Two flags change where that command comes from:

```bash
npx -y pi-scholar-mcp install --local      # run this checkout
npx -y pi-scholar-mcp install --from github:kaipol/pi-scholar-mcp
```

`--from` is for the window before the package reaches npm — it points the
clients at the GitHub repository instead. The only difference between all three
forms is the `command` and `args` of the server entry, so moving between them is
a matter of re-running `install`.

## Manual configuration

For a client the installer does not know about, the server is ordinary MCP over
stdio, so wiring it by hand is three fields:

```json
{
  "mcpServers": {
    "pi-scholar": {
      "command": "npx",
      "args": ["-y", "pi-scholar-mcp@latest"],
      "env": { "PI_SCHOLAR_VAULT": "~/pi-scholar-vault" }
    }
  }
}
```

Then copy `skills/*/SKILL.md` into wherever your client reads skills from. A
TOML-shaped client takes the same thing as:

```toml
[mcp_servers.pi-scholar]
enabled = true
command = "npx"
args = ["-y", "pi-scholar-mcp@latest"]
startup_timeout_sec = 120

[mcp_servers.pi-scholar.env]
PI_SCHOLAR_VAULT = "~/pi-scholar-vault"
```

## The skills

| Skill | What it drives |
| --- | --- |
| `scholar-extract` | Drain the pending inbox into immutable published chunks |
| `scholar-ingest` | Turn published extractions into guarded wiki pages |
| `scholar-lint` | Audit the finished wiki and apply guarded repairs |
| `scholar-daily` | Propose today's spaced-repetition quiz |
| `scholar-quiz-grader` | Settle a sealed quiz submission |

Each one is a self-contained document: the guarded workflow it must follow, the
contracts of the tools it calls, and the record shapes those tools return. The
tool contracts in them were established by driving the real server, not by
reading the source — for example, `scholar_get_lint_context` returns
`{ scope, pages, issues }` and **no** `workflowRequestId`, which is why
`scholar_finish_lint` takes no arguments, and why the skills say so explicitly.

## The vault

The vault is a plain directory holding Markdown, git, and a SQLite index. It is
created by `pi-scholar-mcp vault <path>` or automatically by `install`, and it
is the only piece of state the server needs. Point several clients at the same
vault if you want them to share one knowledge base.

Every path a tool returns is relative to the vault root, so joining the root
with the returned relative path is always correct.

## Windows

pi-scholar v0.0.1 has two bugs that only bite on Windows. Both are patched
idempotently at server startup by `src/patch-windows.mjs`:

1. `dist/external/process.js` requires POSIX executable permission bits
   (`(stat.mode & 0o111) !== 0`), which Node never reports on Windows, and its
   PATH search looks for the bare name only, so `git` is never found behind
   `git.exe`. The patch skips the exec-bit requirement on win32 and tries the
   `.exe` extension.
2. `dist/vault.js` validates slash-separated relative paths with win32
   `normalize()`, which rewrites `/` to `\` and therefore rejects every path
   pi-scholar generates internally. The patch compares with `posix.normalize`.

Because the patches edit files inside the installed `pi-scholar` package, they
run from a `postinstall` hook and are safe to run repeatedly.

## qmd

pi-scholar can use [qmd](https://github.com/tobi/qmd) for semantic ranking, but
treats it as optional. Exact and lexical wiki navigation work without it. The
wiki *mutation* path, however, insists an index adapter exists, so the server
injects a stub: `index` is a no-op and `search` fails with an explicit message
rather than pretending to rank. Install qmd and the stub stops mattering.

## Development

```bash
npm install
npm test                   # entry + smoke + full lifecycle + skill contract checks
npm run doctor             # end-to-end check of this working copy
npm run doctor -- --remote # also fetch and run the package the clients run
```

The tests run against throwaway vaults in the system temp directory, so they
never touch `~/pi-scholar-vault`.

`src/entry-test.mjs` spawns `bin/pi-scholar-mcp.mjs` with no subcommand — the
exact thing a client execs — and requires a full handshake through it. Every
other test spawns `src/server.mjs` directly, which is why a wrong import in the
bin entry shipped once and stayed invisible until someone installed the package.

`src/lifecycle-test.mjs` drives the complete guarded cycle — add a source,
extract it, publish the claim, ingest it, create a page, finish — because that
path is the one a real skill run takes, and it is where the digest guards, the
qmd adapter, and workflow finalization actually get exercised.

`doctor --remote` is the check that matters for "does it run without local
files": it reads the command back out of the live client config and runs that.
It is off by default because a cold npx cache makes it slow.

### Windows note

On Windows the npm shims (`npx`, `npm`) are `.cmd` files, and Node will not exec a
`.cmd` without a shell. `src/mcp-stdio.mjs` therefore routes such commands
through `cmd /d /s /c`, which is what real MCP clients do. If you write your own
spawn code against this package, do the same or the server will never start.

## License

MIT, same as pi-scholar.
