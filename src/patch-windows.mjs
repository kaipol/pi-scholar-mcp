// Idempotent Windows compatibility patches for pi-scholar v0.0.1 dist.
//
// Upstream bug 1, dist/external/process.js:
//   - assertExecutableFile requires POSIX exec permission bits
//     ((stat.mode & 0o111) !== 0). On Windows node reports mode 0o666 for
//     every regular file, so no child executable can ever pass.
//   - findBareExecutable searches PATH for the bare name only; Windows
//     executables live behind the .exe extension, so git / docling / qmd
//     are never found ("child executable was not found in PATH: git").
//   Fix: skip the exec-bit requirement on win32 (accessSync X_OK still applies)
//   and try name.exe on win32.
//
// Upstream bug 2, dist/vault.js safeRelativePath:
//   - It validates slash-separated relative paths with win32 normalize(),
//     which rewrites "/" to "\" on Windows, so every internally generated
//     path (e.g. ".pi-scholar/work/<id>/original") fails the
//     "path must be normalized and contained" check.
//   Fix: use posix.normalize / posix.sep for the normalization comparison.
//
// Both patches are applied by the pi-scholar MCP bridge at startup.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distCandidates } from "./resolve-dist.mjs";

const MARKER = "/* pi-scholar-win32-patch */";

function note(message) {
  process.stderr.write(message + "\n");
}

const distRoots = distCandidates();

function distFile(relative) {
  const found = distRoots.map((root) => join(root, relative)).find((p) => existsSync(p));
  if (!found) {
    note(`[pi-scholar-win32-patch] not found: ${relative}`);
    process.exit(1);
  }
  return found;
}

function patch(relative, apply) {
  const target = distFile(relative);
  const source = readFileSync(target, "utf8");
  if (source.includes(MARKER)) {
    note(`[pi-scholar-win32-patch] already applied: ${relative}`);
    return;
  }
  const patched = apply(source);
  if (patched === source) {
    note(`[pi-scholar-win32-patch] anchor mismatch in ${relative}; dist changed upstream`);
    process.exit(1);
  }
  writeFileSync(target, patched);
  note(`[pi-scholar-win32-patch] applied: ${relative}`);
}

// --- Patch 1: external/process.js -----------------------------------------
patch("external/process.js", (source) => {
  const execBitFix = source.replace(
    "if (!stat.isFile() || (stat.mode & 0o111) === 0)",
    MARKER + ' if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0))',
  );
  if (execBitFix === source) return source;
  const innerLoop = [
    "for (const candidate of (process.platform === \"win32\" ? [name, name + \".exe\"] : [name])) {",
    "            try {",
    "                return assertExecutableFile(join(directory, candidate));",
    "            }",
    "            catch {",
    "                // Try the next closed PATH entry.",
    "            }",
    "        }",
  ].join("\n");
  return execBitFix.replace("return assertExecutableFile(join(directory, name));", innerLoop);
});

// --- Patch 2: vault.js safeRelativePath ------------------------------------
patch("vault.js", (source) => {
  return source.replace(
    "const normalized = normalize(requestedPath);",
    MARKER +
      ' const normalized = (process.platform === "win32" ? posix.normalize(requestedPath) : normalize(requestedPath));',
  );
});
