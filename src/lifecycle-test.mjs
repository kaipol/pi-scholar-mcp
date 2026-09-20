// Full business cycle through the bridge: stage a source, extract it, publish
// the claim, ingest it, create a wiki page, and finish. This is the path a
// real skill run takes, so it exercises the qmd index adapter, the digest
// guards, and workflow finalization.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarness } from "./test-harness.mjs";

const harness = await startHarness();

const added = await harness.call("scholar_add", {
  kind: "text",
  text: [
    "Chunk Test Method",
    "",
    "The chunk test method verifies that bounded source extraction preserves evidence for citations.",
    "Every claim must cite an immutable chunk ordinal.",
  ].join("\n"),
  displayName: "Lifecycle test source",
});

const pendingSourceId = added.json().source?.sourceId ?? added.json().sourceId;
if (!pendingSourceId) {
  console.error("no pending sourceId returned:", added.text.slice(0, 300));
  harness.close();
  process.exit(1);
}

const extract = await harness.call("scholar_get_extract_context", { pendingSourceIds: [pendingSourceId] });
if (extract.isError) {
  console.error("get_extract_context failed:", extract.text.slice(0, 500));
  harness.close();
  process.exit(1);
}
const claims = extract.json().claims ?? [];
if (claims.length === 0) {
  console.error("no claims returned:", extract.text.slice(0, 300));
  harness.close();
  process.exit(1);
}

const claim = claims[0];
const extractedPath = join(harness.vault, claim.extractedPath);
const totalLines = readFileSync(extractedPath, "utf8").split(/\r?\n/).length;

const published = await harness.call("scholar_publish_extraction", {
  claimId: claim.claimId,
  preparedId: claim.preparedId,
  digest: claim.digest,
  endpoints: [1, totalLines],
});
if (published.isError) {
  console.error("publish_extraction failed:", published.text.slice(0, 500));
  harness.close();
  process.exit(1);
}
const publishedSourceId = published.json().sourceId ?? published.json().source?.sourceId;
if (!publishedSourceId) {
  console.error("no published sourceId:", published.text.slice(0, 500));
  harness.close();
  process.exit(1);
}

const ingest = await harness.call("scholar_get_ingest_context", { sourceIds: [publishedSourceId] });
if (ingest.isError) {
  console.error("get_ingest_context failed:", ingest.text.slice(0, 500));
  harness.close();
  process.exit(1);
}
const workflowRequestId = ingest.json().workflowRequestId;
if (!workflowRequestId) {
  console.error("no workflowRequestId:", ingest.text.slice(0, 500));
  harness.close();
  process.exit(1);
}

const applied = await harness.call("scholar_apply_ingest", {
  workflowRequestId,
  change: {
    kind: "create-page",
    path: "lifecycle-test.md",
    title: "Chunk Test Method",
    description: "Verification page for the bridge lifecycle test.",
    body: [
      "The chunk test method verifies that bounded source extraction preserves evidence for citations.[^" + publishedSourceId + ":0]",
      "",
      "Every claim must cite an immutable chunk ordinal.",
      "",
      "```text",
      "pi-scholar lifecycle test",
      "```",
    ].join("\n"),
  },
});
if (applied.isError) {
  console.error("apply_ingest failed:", applied.text.slice(0, 400));
  harness.close();
  process.exit(1);
}

const finished = await harness.call("scholar_finish_ingest", { workflowRequestId });
if (finished.isError || finished.json().status !== "completed") {
  console.error("finish_ingest failed:", finished.text.slice(0, 300));
  harness.close();
  process.exit(1);
}

harness.close();
console.log("FULL LIFECYCLE TEST PASSED");
process.exit(0);
