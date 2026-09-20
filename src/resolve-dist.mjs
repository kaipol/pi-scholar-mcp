// Resolves the pi-scholar package's dist directory.
//
// The server used to read the dist straight out of a hand-placed checkout
// (D:/download/pi-scholar/dist). Now that pi-scholar is a normal npm dependency
// the dist is resolved from node_modules, so the same code runs from a clone,
// from npx, or from a global install without any local path.
//
// Resolution order:
//   1. PI_SCHOLAR_DIST          explicit override
//   2. the pi-scholar dependency require.resolve("pi-scholar")

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function fromEnvironment() {
  const override = process.env.PI_SCHOLAR_DIST;
  if (!override) return undefined;
  return override.replace(/\/+$/, "");
}

function fromDependency() {
  try {
    const require = createRequire(import.meta.url);
    // pi-scholar's package.json declares an "exports" map that does not expose
    // ./package.json, so resolve the main entry ("./dist/index.js") instead and
    // take its directory. require.resolve already returns a filesystem path.
    const main = require.resolve("pi-scholar");
    const dist = dirname(main);
    return existsSync(join(dist, "application/application.js")) ? dist : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDist() {
  const dist = [fromEnvironment(), fromDependency()].find(Boolean);
  if (!dist) {
    throw new Error(
      "pi-scholar runtime not found. Install it (npm install pi-scholar) or set PI_SCHOLAR_DIST to its dist directory.",
    );
  }
  return dist;
}

export function distCandidates() {
  return [fromEnvironment(), fromDependency()].filter(Boolean);
}
