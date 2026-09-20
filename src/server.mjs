#!/usr/bin/env node
// pi-scholar MCP server.
//
// Wraps the pi-scholar application layer (the same ScholarApplication the
// bundled Pi extension drives) as a dependency-free MCP stdio server, so the
// scholar_* tools become available to any MCP client: ZCode, Claude Code,
// Codex, or anything else that speaks the protocol.
//
// Configuration (environment):
//   PI_SCHOLAR_DIST   path to the pi-scholar package dist directory. Defaults to
//                     the pi-scholar npm dependency resolved from node_modules,
//                     so no local checkout is needed.
//   PI_SCHOLAR_VAULT  path to the vault to operate on. When unset, the vault is
//                     resolved from ~/pi-scholar-vault and then the working
//                     directory, like the Pi extension resolves it from cwd.
//
// The tool set, schemas, and the guarded workflow lifecycle (context -> apply ->
// finish, extract claim tracking, replay on failure) mirror
// pi-scholar/pi/extension.ts. Deviations are marked with `// DEVIATION:`.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveDist } from "./resolve-dist.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Apply the idempotent win32 patch (POSIX exec-bit check + .exe PATH lookup)
// before any pi-scholar module is loaded.
await import(pathToFileURL(join(here, "patch-windows.mjs")).href);

const DIST = resolveDist();

const log = (...parts) => process.stderr.write(`[pi-scholar-mcp] ${parts.join(" ")}\n`);

log(`loading pi-scholar runtime from ${DIST}`);
const vaultModule = await import(pathToFileURL(join(DIST, "vault.js")).href);
const applicationModule = await import(pathToFileURL(join(DIST, "application/application.js")).href);
log("runtime loaded");

// ---------------------------------------------------------------------------
// Vault / application management
// ---------------------------------------------------------------------------

const appCache = new Map(); // vaultRoot -> Promise<ScholarApplication>
const gradingClaimOwner = randomUUID();

// qmd (semantic wiki ranking, github.com/tobi/qmd) is an optional external
// dependency: pi-scholar's exact and lexical navigation work without it, but
// the wiki mutation path insists an index adapter exists. This stub keeps
// guarded mutations working while keeping semantic search honestly failing
// until qmd is installed.
const qmdStub = {
  search: async () => {
    throw new Error(
      "qmd semantic index is unavailable: the optional qmd tool is not installed; exact and lexical wiki navigation remain available",
    );
  },
  index: async () => {},
};

const DEFAULT_VAULT = join(homedir(), "pi-scholar-vault");

function vaultRoots() {
  const roots = [];
  const flagIndex = process.argv.indexOf("--vault");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) roots.push(process.argv[flagIndex + 1]);
  if (process.env.PI_SCHOLAR_VAULT) roots.push(process.env.PI_SCHOLAR_VAULT);
  roots.push(DEFAULT_VAULT);
  roots.push(process.cwd());
  return roots;
}

async function resolveVaultPaths() {
  const errors = [];
  for (const root of vaultRoots()) {
    try {
      return vaultModule.resolveVault(root);
    } catch (error) {
      errors.push(`${root}: ${error.message}`);
    }
  }
  throw new Error(
    `No Pi Scholar vault found. Run "node ${DIST}/cli.js init <path>" first, or set PI_SCHOLAR_VAULT. Tried: ${errors.join(" | ")}`,
  );
}

async function applicationFor() {
  const paths = await resolveVaultPaths();
  const cached = appCache.get(paths.vaultRoot);
  if (cached) return cached;
  const pending = (async () => {
    const app = await applicationModule.createApplication({ paths, adapters: { wiki: { qmd: qmdStub } } });
    try {
      await app.recoverAbandonedWorkflows();
      return app;
    } catch (error) {
      try {
        await app.close?.();
      } catch {}
      throw error;
    }
  })();
  appCache.set(paths.vaultRoot, pending);
  try {
    return await pending;
  } catch (error) {
    if (appCache.get(paths.vaultRoot) === pending) appCache.delete(paths.vaultRoot);
    throw error;
  }
}

async function closeApplications() {
  const pending = [...appCache.values()];
  appCache.clear();
  const settled = await Promise.allSettled(pending);
  await Promise.all(
    settled.flatMap((r) => (r.status === "fulfilled" ? [r.value.close?.()] : [])),
  );
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void closeApplications().finally(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Workflow lifecycle guards (ported from pi/extension.ts)
// ---------------------------------------------------------------------------

const workflowStates = new Map(); // `${vaultRoot}:${kind}` -> state

const LIFECYCLE_KINDS = new Set(["extract", "ingest", "lint", "daily", "quiz-grader", "sync"]);

function workflowKey(app, kind) {
  return `${app.paths.vaultRoot}:${kind}`;
}

function lifecycleContextValue(kind, requestId, value) {
  if (kind !== "ingest") return value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ingest context must be an object");
  return { ...value, workflowRequestId: requestId };
}

function workflowError(error) {
  return {
    errorCode:
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "PI_WORKFLOW_FAILED",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function extractClaimKey(input) {
  return `${input.claimId}\u0000${input.preparedId}`;
}

function extractWorkflowFailure() {
  return {
    progress: 1,
    message: "Workflow completed with extraction failures",
    errorCode: "PI_WORKFLOW_FAILED",
    errorMessage: "One or more extraction entries failed",
  };
}

function workflowFinalizationApplied(error) {
  if (!error || typeof error !== "object" || !("details" in error)) return false;
  const details = error.details;
  return details !== null && typeof details === "object" && "applied" in details && details.applied === true;
}

function publicationFinalizationApplied(error) {
  if (!workflowFinalizationApplied(error) || !error || typeof error !== "object") return false;
  return "publicationApplied" in error && error.publicationApplied === true;
}

function recordExtractAttempt(state, claimKey, succeeded) {
  if (!claimKey || !state.expectedClaimKeys.has(claimKey)) return { state, accepted: false, finished: false };
  if (state.attemptedClaimKeys.has(claimKey))
    return {
      state,
      accepted: true,
      finished: state.attemptedClaimKeys.size === state.expectedClaimKeys.size,
    };
  const attemptedClaimKeys = new Set(state.attemptedClaimKeys);
  attemptedClaimKeys.add(claimKey);
  const completedClaimKeys = new Set(state.completedClaimKeys);
  if (succeeded) completedClaimKeys.add(claimKey);
  const activeState = { ...state };
  if (succeeded) delete activeState.replayContext;
  const next = {
    ...activeState,
    attemptedClaimKeys,
    completedClaimKeys,
    failed: state.failed || !succeeded,
  };
  return { state: next, accepted: true, finished: attemptedClaimKeys.size === state.expectedClaimKeys.size };
}

async function persistExtractAttempt(app, key, attempt) {
  if (attempt.finished) {
    await app.finishWorkflow(
      attempt.state.requestId,
      attempt.state.failed ? "failed" : "succeeded",
      attempt.state.failed ? extractWorkflowFailure() : { progress: 1, message: "Workflow completed" },
    );
    workflowStates.delete(key);
  } else {
    const remaining = attempt.state.expectedClaimKeys.size - attempt.state.attemptedClaimKeys.size;
    await app.updateWorkflow(attempt.state.requestId, {
      progress: 0.5,
      message: `${remaining} extraction(s) remaining`,
    });
  }
}

async function lifecycleContext(kind, operation) {
  const app = await applicationFor();
  const key = workflowKey(app, kind);
  const existingState = workflowStates.get(key);
  if (existingState && "replayContext" in existingState && existingState.replayContext !== undefined) {
    const { replayContext, finalizedReplay, ...activeState } = existingState;
    if (finalizedReplay) {
      workflowStates.delete(key);
      return lifecycleContextValue(kind, activeState.requestId, replayContext);
    }
    const automaticallyFinalized =
      ("remaining" in activeState && activeState.remaining === 0) ||
      ("expectedClaimKeys" in activeState && activeState.expectedClaimKeys.size === 0);
    if (automaticallyFinalized) {
      const failed = "expectedClaimKeys" in activeState && activeState.failed;
      try {
        await app.finishWorkflow(
          activeState.requestId,
          failed ? "failed" : "succeeded",
          failed ? extractWorkflowFailure() : { progress: 1, message: "Workflow completed" },
        );
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.set(key, { ...existingState, finalizedReplay: true });
        throw persistenceError;
      }
    } else {
      workflowStates.set(key, activeState);
    }
    return lifecycleContextValue(kind, activeState.requestId, replayContext);
  }
  if (existingState) throw new Error(`${kind} workflow is already running`);

  let state;
  let result;
  try {
    const started = await app.beginWorkflow(kind);
    const requestId = started.workflow.requestId;
    state =
      kind === "extract"
        ? {
            requestId,
            expectedClaimKeys: new Set(),
            attemptedClaimKeys: new Set(),
            completedClaimKeys: new Set(),
            failed: false,
          }
        : { requestId, remaining: 1 };
    result = await operation(app);
  } catch (error) {
    if (state) {
      workflowStates.set(key, state);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
      }
    }
    throw error;
  }

  if (!state) throw new Error("workflow state unavailable");
  const requestId = state.requestId;
  if (kind === "extract") {
    const context = result;
    const expectedClaimKeys = new Set(
      (Array.isArray(context.claims) ? context.claims : []).map((claim) => extractClaimKey(claim)),
    );
    const extractState = {
      requestId,
      expectedClaimKeys,
      attemptedClaimKeys: new Set(),
      completedClaimKeys: new Set(),
      failed: Array.isArray(context.failures) && context.failures.length > 0,
    };
    workflowStates.set(key, extractState);
    try {
      if (expectedClaimKeys.size === 0) {
        await app.finishWorkflow(
          requestId,
          extractState.failed ? "failed" : "succeeded",
          extractState.failed ? extractWorkflowFailure() : { progress: 1, message: "Workflow completed" },
        );
        workflowStates.delete(key);
      } else {
        await app.updateWorkflow(requestId, { progress: 0.25, message: "Context loaded" });
      }
    } catch (persistenceError) {
      workflowStates.set(key, {
        ...extractState,
        replayContext: context,
        ...(expectedClaimKeys.size === 0 && workflowFinalizationApplied(persistenceError) ? { finalizedReplay: true } : {}),
      });
      throw persistenceError;
    }
  } else {
    const remaining = kind === "daily" && result && result.maintenanceEnabled ? 0 : 1;
    const nextState = { requestId, remaining };
    workflowStates.set(key, nextState);
    try {
      if (remaining === 0) {
        await app.finishWorkflow(requestId, "succeeded", { progress: 1, message: "Workflow completed" });
        workflowStates.delete(key);
      } else {
        await app.updateWorkflow(requestId, { progress: 0.25, message: "Context loaded" });
      }
    } catch (persistenceError) {
      workflowStates.set(key, {
        ...nextState,
        replayContext: result,
        ...(remaining === 0 && workflowFinalizationApplied(persistenceError) ? { finalizedReplay: true } : {}),
      });
      throw persistenceError;
    }
  }
  return lifecycleContextValue(kind, requestId, result);
}

async function lifecycleFinal(kind, operation, claimKey) {
  const app = await applicationFor();
  const key = workflowKey(app, kind);
  const state = workflowStates.get(key);
  if (!state) throw new Error(`${kind} context is required before the final tool`);

  let result;
  try {
    result = await operation(app);
  } catch (error) {
    if (kind === "ingest" || kind === "lint") {
      workflowStates.set(key, state);
    } else if (kind === "extract") {
      if (publicationFinalizationApplied(error)) {
        const attempt = recordExtractAttempt(state, claimKey, true);
        workflowStates.set(key, attempt.state);
      } else {
        const attempt = recordExtractAttempt(state, claimKey, false);
        if (attempt.accepted) {
          workflowStates.set(key, attempt.state);
          try {
            await persistExtractAttempt(app, key, attempt);
          } catch (persistenceError) {
            if (attempt.finished && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
            else workflowStates.set(key, attempt.state);
          }
        }
      }
    } else {
      workflowStates.set(key, state);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
      }
    }
    throw error;
  }

  if (kind === "ingest" || kind === "lint") {
    const { replayContext: _replayContext, ...activeState } = state;
    workflowStates.set(key, activeState);
  } else if (kind === "extract") {
    const attempt = recordExtractAttempt(state, claimKey, true);
    if (attempt.accepted) {
      workflowStates.set(key, attempt.state);
      try {
        await persistExtractAttempt(app, key, attempt);
      } catch (persistenceError) {
        if (attempt.finished && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, attempt.state);
        throw persistenceError;
      }
    }
  } else {
    const remaining = state.remaining - 1;
    if (remaining <= 0) {
      try {
        await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
        throw persistenceError;
      }
    } else {
      await app.updateWorkflow(state.requestId, { progress: 0.5, message: `${remaining} extraction(s) remaining` });
      workflowStates.set(key, { requestId: state.requestId, remaining });
    }
  }
  return result;
}

async function lifecycleIngestApply(requestId, operation) {
  const app = await applicationFor();
  const state = workflowStates.get(workflowKey(app, "ingest"));
  if (!state) throw new Error("ingest context is required before applying");
  if (state.requestId !== requestId) throw new Error("ingest workflow ID does not match the current context");
  return lifecycleFinal("ingest", operation);
}

async function lifecycleFinish(kind) {
  const app = await applicationFor();
  const key = workflowKey(app, kind);
  const state = workflowStates.get(key);
  if (!state) throw new Error(`${kind} context is required before finishing`);

  try {
    await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
    workflowStates.delete(key);
  } catch (persistenceError) {
    if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
    else workflowStates.set(key, state);
    throw persistenceError;
  }
  return { status: "completed" };
}

// ---------------------------------------------------------------------------
// Input normalization helpers (ported from pi/extension.ts)
// ---------------------------------------------------------------------------

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object");
  return value;
}

async function stage(app, params) {
  const input = { ...params };
  for (const key of ["path", "filePath", "url", "name", "displayName", "originalName", "mediaType"])
    if (input[key] === "") delete input[key];
  if (typeof input.kind !== "string") {
    if (typeof input.url === "string") input.kind = "url";
    else if (typeof input.text === "string") input.kind = "pasted";
  }
  return app.stageSource(input);
}

async function note(app, params) {
  const body = typeof params.body === "string" ? params.body : typeof params.content === "string" ? params.content : undefined;
  const title = typeof params.title === "string" ? params.title : undefined;
  const description = typeof params.description === "string" ? params.description : undefined;
  const quizWorthinessValue = params.quizWorthiness;
  const quizWorthiness =
    quizWorthinessValue === "eligible" || quizWorthinessValue === "skip" || quizWorthinessValue === "unknown"
      ? quizWorthinessValue
      : undefined;
  const path = typeof params.path === "string" ? params.path : undefined;
  if (typeof params.pageId === "string") {
    if (body === undefined && title === undefined && description === undefined && quizWorthiness === undefined && path === undefined)
      throw new Error("an update is required");
    const update = {
      ...(body === undefined ? {} : { body }),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(quizWorthiness === undefined ? {} : { quizWorthiness }),
      ...(path === undefined ? {} : { path }),
    };
    return app.updateNote(params.pageId, update);
  }
  if (typeof body !== "string" || !body.trim()) throw new Error("body or content is required");
  return app.createNote({ path: path ?? "", title, description, body, quizWorthiness });
}

// ---------------------------------------------------------------------------
// JSON Schema definitions (ported from the typebox definitions)
// ---------------------------------------------------------------------------

const WIKI_MARKDOWN_AUTHORING =
  "For model-authored Markdown, use $...$ for inline LaTeX and put opening and closing $$ delimiters on separate lines around display LaTeX; never wrap formulas in backticks or use \\(...\\) or \\[...\\]. Put every code, pseudocode, or command example in a fenced code block with an accurate language tag; inline code is only for a single literal identifier, path, command name, or token. Include a fenced Mermaid diagram only when it materially clarifies a relationship, process, state transition, architecture, data flow, or algorithm; keep it focused, cite source-grounded claims nearby, and never add diagrams by quota, for decoration, or to repeat prose, tables, equations, or another diagram.";

const OKF_DESCRIPTION =
  "Compact OKF selection summary metadata for this page, not source evidence or instructions. Optional for skip/unknown; required and non-empty when the resulting quizWorthiness is eligible. For an eligible update, omit only to preserve the existing valid description or provide a non-empty replacement. Eligible pages also require a renderable body.";

const quizWorthinessSchema = { type: "string", enum: ["eligible", "skip", "unknown"] };
const str = (description) => ({ type: "string", ...(description ? { description } : {}) });

const wikiChangeBody = (description) => ({ type: "string", description: `${description} ${WIKI_MARKDOWN_AUTHORING}` });

const wikiChangeIssuePageInput = {
  type: "object",
  required: ["pageId", "expectedDigest"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    expectedDigest: { type: "string", minLength: 1 },
    title: str(),
    description: { ...str(OKF_DESCRIPTION), minLength: 1 },
    body: wikiChangeBody("Replacement Markdown body. When resolve-issue leaves or makes the page eligible, the resulting page must have a renderable body."),
    quizWorthiness: quizWorthinessSchema,
  },
};

const wikiChangeInput = {
  // The client validates that every tool's inputSchema is an object type, so
  // the discriminated union is declared as an object whose value must match one
  // branch. Each branch already carries its own type: "object".
  type: "object",
  anyOf: [
    {
      type: "object",
      required: ["kind", "path", "body"],
      properties: {
        kind: { const: "create-page" },
        path: { type: "string", minLength: 1 },
        title: str(),
        description: { ...str(OKF_DESCRIPTION), minLength: 1 },
        body: wikiChangeBody("Complete Markdown body; model-authored source pages must teach at textbook depth and cite supporting source chunks. An eligible page must have a renderable body."),
        quizWorthiness: quizWorthinessSchema,
      },
    },
    {
      type: "object",
      required: ["kind", "pageId", "expectedDigest"],
      properties: {
        kind: { const: "update-page" },
        pageId: { type: "string", minLength: 1 },
        expectedDigest: { type: "string", minLength: 1 },
        title: str(),
        description: { ...str(OKF_DESCRIPTION), minLength: 1 },
        body: wikiChangeBody("Complete replacement Markdown body; model-authored source pages must teach at textbook depth and cite supporting source chunks. An eligible resulting page must have a renderable body."),
        quizWorthiness: quizWorthinessSchema,
      },
    },
    {
      type: "object",
      required: ["kind", "pageId", "expectedDigest", "path"],
      properties: {
        kind: { const: "rename-page" },
        pageId: { type: "string", minLength: 1 },
        expectedDigest: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["kind", "pageId", "prerequisitePageIds"],
      properties: {
        kind: { const: "prerequisites" },
        pageId: { type: "string", minLength: 1 },
        prerequisitePageIds: { type: "array", items: { type: "string", minLength: 1 } },
        expectedRevision: { type: "integer", minimum: 1 },
      },
    },
    {
      type: "object",
      required: ["kind", "issueId", "page", "resolution"],
      properties: {
        kind: { const: "resolve-issue" },
        issueId: { type: "string", minLength: 1 },
        page: wikiChangeIssuePageInput,
        resolution: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["kind", "pageId", "expectedDigest"],
      properties: {
        kind: { const: "retire-page" },
        pageId: { type: "string", minLength: 1 },
        expectedDigest: { type: "string", minLength: 1 },
      },
    },
  ],
};

const gradeReadingInput = {
  type: "object",
  required: ["pageId", "anchor"],
  properties: { pageId: { type: "string", minLength: 1 }, anchor: { type: "string" }, heading: str() },
};

const gradePageInput = {
  type: "object",
  required: ["pageId", "rating", "evidence"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    rating: { type: "string", enum: ["Again", "Hard", "Good", "Easy"] },
    feedback: str(),
    evidence: { type: "array", items: { type: "string" } },
    readings: { type: "array", items: gradeReadingInput },
  },
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "scholar_add",
    description:
      "Stage a typed source (file path, directory, URL, pasted text, note, or code) in the Pi Scholar inbox. Also usable by lint research children for web-sourced staging.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["document", "url", "text", "pasted", "note", "code", "directory", "repository"] },
        path: str("Filesystem path for document/note/code/directory/repository sources."),
        filePath: str(),
        url: str("HTTP(S) URL for url sources."),
        text: str("Inline text for pasted sources (or text: payload)."),
        name: str(),
        displayName: str(),
        originalName: str(),
        mediaType: str(),
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return stage(app, params);
    },
  },
  {
    name: "scholar_issue",
    description:
      "Report an incorrect, unclear, missing, or badly bounded wiki item so a later lint pass can repair it. DEVIATION: in Pi this was the /scholar-issue command.",
    inputSchema: {
      type: "object",
      required: ["kind", "description"],
      properties: {
        kind: { type: "string", enum: ["incorrect", "unclear", "missing", "bad-boundary"], description: "Issue category." },
        description: str("What is wrong and where."),
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return app.reportIssue(params);
    },
  },
  {
    name: "scholar_note",
    description:
      "Create or update a guarded wiki note. Preserve user prose; model-authored source notes must teach at textbook depth, not merely summarize.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: str("When set, update the existing page instead of creating one."),
        path: str(),
        title: str(),
        description: str(OKF_DESCRIPTION),
        body: wikiChangeBody("Complete Markdown body. Preserve user-authored prose; model-authored source notes must be self-contained textbook-style exposition with nearby source-chunk citations. An eligible page must have a renderable body."),
        content: wikiChangeBody("Alias for body."),
        quizWorthiness: quizWorthinessSchema,
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return note(app, params);
    },
  },
  {
    name: "scholar_remove_source",
    description:
      "Preview source dependents, then remove the source only after explicit user confirmation in chat. DEVIATION: call once without confirm to get the preview and confirmationId; only set confirm:true after the user has agreed, passing the current confirmationId.",
    inputSchema: {
      type: "object",
      required: ["sourceId"],
      properties: {
        sourceId: str("Source to preview or remove."),
        confirmationId: str("Current confirmationId from the removal preview; required when confirm is true."),
        confirm: { type: "boolean", description: "Set true only after explicit user confirmation in chat." },
      },
    },
    async execute(params) {
      const app = await applicationFor();
      const sourceId = String(params.sourceId ?? "").trim();
      if (!sourceId) throw new Error("sourceId is required");
      const preview = await app.removalPreview(sourceId);
      if (params.confirm !== true) return preview;
      const confirmationId = String(params.confirmationId ?? (preview && typeof preview === "object" ? preview.confirmationId : "") ?? "");
      if (!confirmationId) throw new Error("A current removal confirmation is required");
      const current = await app.removalPreview(sourceId);
      if (String((current && typeof current === "object" ? current.confirmationId : "") ?? "") !== confirmationId)
        return { stale: true, preview: current };
      return app.removeSource(sourceId, confirmationId);
    },
  },
  {
    name: "scholar_search",
    description: "Search trusted wiki content with qmd semantic ranking.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: str(),
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return app.searchWiki(params.query, { mode: "semantic", limit: params.limit });
    },
  },
  {
    name: "scholar_status",
    description: "Read bounded Pi Scholar status facts (vault, workflows, learning, doctor, Git).",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const app = await applicationFor();
      return app.status();
    },
  },
  {
    name: "scholar_get_extract_context",
    description:
      "Claim either the exact pending source IDs supplied or the canonical next stable batch of at most three.",
    inputSchema: {
      type: "object",
      properties: {
        pendingSourceIds: {
          type: "array",
          maxItems: 3,
          items: { type: "string", minLength: 1 },
          description: "Exact pending source IDs to claim in caller order. Omit to claim the canonical next batch of at most three.",
        },
      },
    },
    async execute(params) {
      return lifecycleContext("extract", (app) => app.getExtractContext(params ?? {}, () => {}));
    },
  },
  {
    name: "scholar_publish_extraction",
    description: "Publish one claimed source extraction with validated 1-based line endpoints.",
    inputSchema: {
      type: "object",
      required: ["claimId", "preparedId", "digest", "endpoints"],
      properties: {
        claimId: { type: "string", minLength: 1 },
        preparedId: { type: "string", minLength: 1 },
        digest: { type: "string", minLength: 1 },
        endpoints: {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 1 },
          description: "Exact 1-based extracted-line endpoints; include the final extracted line.",
        },
      },
    },
    async execute(params) {
      return lifecycleFinal("extract", (app) => app.publishExtraction(params), extractClaimKey(params));
    },
  },
  {
    name: "scholar_get_ingest_context",
    description:
      "Read the current wiki and either the exact requested published sources or every published verified packet.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Exact published source IDs to include. Omit for every published verified packet; page and issue scope is unchanged.",
        },
      },
    },
    async execute(params) {
      return lifecycleContext("ingest", (app) => app.getIngestContext(params ?? {}));
    },
  },
  {
    name: "scholar_apply_ingest",
    description: "Apply one guarded source-grounded wiki change under the parent ingest workflow.",
    inputSchema: {
      type: "object",
      required: ["workflowRequestId", "change"],
      properties: {
        workflowRequestId: {
          type: "string",
          minLength: 1,
          description: "Opaque ingest workflow ID returned by scholar_get_ingest_context; pass it unchanged.",
        },
        change: wikiChangeInput,
      },
    },
    async execute(params) {
      const requestId = String(params.workflowRequestId ?? "").trim();
      if (!requestId) throw new Error("workflowRequestId is required");
      return lifecycleIngestApply(requestId, (app) => app.applyIngestChange(params.change, requestId));
    },
  },
  {
    name: "scholar_finish_ingest",
    description: "Finish an ingest context after submitting all bounded changes, including none.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return lifecycleFinish("ingest");
    },
  },
  {
    name: "scholar_get_lint_context",
    description: "Read the final wiki for a full or targeted lint scope.",
    inputSchema: {
      type: "object",
      properties: { description: str("Optional trimmed description for a targeted lint request; omit for full scope.") },
    },
    async execute(params) {
      const description = typeof params?.description === "string" ? params.description.trim() : "";
      return lifecycleContext("lint", (app) => app.getLintContext(description ? { description } : undefined));
    },
  },
  {
    name: "scholar_apply_lint",
    description: "Apply one guarded wiki change during lint; split and merge use composed operations.",
    inputSchema: wikiChangeInput,
    async execute(params) {
      return lifecycleFinal("lint", (app) => app.applyWikiChange(params));
    },
  },
  {
    name: "scholar_finish_lint",
    description: "Finish a lint context after submitting all bounded changes, including none.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return lifecycleFinish("lint");
    },
  },
  {
    name: "scholar_get_daily_context",
    description:
      "Read the current local-date daily quiz context and maintenance guard. If maintenanceEnabled is true, call no other tool and answer exactly: Daily quiz guarded for <date>. Expired prior quizzes: <expiredCount>. No quiz was published. Substitute the returned values.",
    inputSchema: { type: "object", properties: { date: str("Optional local date override (YYYY-MM-DD).") } },
    async execute(params) {
      return lifecycleContext("daily", (app) => app.getQuizContext(params ?? {}));
    },
  },
  {
    name: "scholar_get_daily_evidence",
    description: "Read authoritative evidence for a selected, currently eligible daily page subset.",
    inputSchema: {
      type: "object",
      required: ["date", "pageIds"],
      properties: {
        date: { type: "string", minLength: 1 },
        pageIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return app.getQuizEvidence(params);
    },
  },
  {
    name: "scholar_publish_daily",
    description:
      "Publish one validated daily quiz proposal or explicit skip after an unguarded daily context; never call when maintenance mode is enabled.",
    inputSchema: {
      // Object-typed discriminated union; see wikiChangeInput above.
      type: "object",
      anyOf: [
        {
          type: "object",
          required: ["status", "date", "questions"],
          properties: {
            status: { const: "published" },
            date: { type: "string", minLength: 1 },
            questions: {
              type: "array",
              items: {
                type: "object",
                required: ["kind", "prompt", "pages", "sourceRefs"],
                properties: {
                  kind: { type: "string", enum: ["free-response", "multiple-choice"] },
                  prompt: { type: "string", minLength: 1 },
                  choices: { type: "array", items: { type: "string" } },
                  pages: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      required: ["pageId", "criterion", "weight"],
                      properties: {
                        pageId: { type: "string", minLength: 1 },
                        criterion: { type: "string", minLength: 1 },
                        weight: { type: "number", exclusiveMinimum: 0 },
                      },
                    },
                  },
                  sourceRefs: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        {
          type: "object",
          required: ["status", "date", "reason"],
          properties: {
            status: { const: "skipped" },
            date: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
      ],
    },
    async execute(params) {
      return lifecycleFinal("daily", (app) => app.publishQuiz(params));
    },
  },
  {
    name: "scholar_get_grading_context",
    description:
      "Atomically claim and read the current sealed quiz revision and submission context for this bridge process.",
    inputSchema: { type: "object", properties: { date: str("Optional local date override (YYYY-MM-DD).") } },
    async execute(params) {
      const app = await applicationFor();
      return app.getGradingContext(params ?? {}, gradingClaimOwner);
    },
  },
  {
    name: "scholar_settle_grade",
    description: "Settle one validated sealed quiz grading result.",
    inputSchema: {
      type: "object",
      required: ["requestId", "date", "revision", "submissionId", "questions", "pages"],
      properties: {
        requestId: { type: "string", minLength: 1 },
        date: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
        submissionId: { type: "string", minLength: 1 },
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["questionId"],
            properties: { questionId: { type: "string", minLength: 1 }, feedback: str() },
          },
        },
        pages: { type: "array", items: gradePageInput },
      },
    },
    async execute(params) {
      const app = await applicationFor();
      return app.settleGrade(params, gradingClaimOwner);
    },
  },
];

// ---------------------------------------------------------------------------
// Sequential execution (Pi's executionMode: "sequential")
// ---------------------------------------------------------------------------

let tail = Promise.resolve();
function enqueue(task) {
  const run = tail.then(() => task(), () => task());
  tail = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2024-11-05";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultFor(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorFor(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function textResult(value) {
  const text = typeof value === "string" ? value : (JSON.stringify(value ?? null) ?? String(value));
  return { content: [{ type: "text", text }], isError: false };
}

function textError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && typeof error.code === "string" ? error.code : undefined;
  return {
    content: [{ type: "text", text: code ? `Error ${code}: ${message}` : `Error: ${message}` }],
    isError: true,
  };
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize": {
      const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      return {
        protocolVersion: requested || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "pi-scholar", title: "Pi Scholar", version: "0.1.0" },
        instructions:
          "Typed Pi Scholar tools over one local vault. The guarded workflows (extract, ingest, lint, daily, quiz-grader) require their context tool before any apply/publish/finish tool in the same bridge process.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case "tools/call": {
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      const result = await enqueue(() => tool.execute(params?.arguments ?? {}))
        .then((value) => textResult(value))
        .catch((error) => {
          log(`tool ${name} failed:`, error instanceof Error ? error.message : error);
          return textError(error);
        });
      return result;
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      log("ignoring unparseable line:", error.message);
      continue;
    }
    if (!message || message.jsonrpc !== "2.0") continue;
    if (typeof message.id !== "number" && typeof message.id !== "string") continue; // notification
    const { id, method, params } = message;
    dispatch(method, params).then(
      (result) => send(resultFor(id, result)),
      (error) => {
        if (error && typeof error.code === "number" && Number.isInteger(error.code))
          send(errorFor(id, error.code, error.message));
        else send(errorFor(id, -32603, error instanceof Error ? error.message : String(error)));
      },
    );
  }
});
process.stdin.on("end", () => {
  void closeApplications().finally(() => process.exit(0));
});

log(`ready; tools: ${tools.length}; vault resolution order: ${vaultRoots().join(" -> ")}`);
