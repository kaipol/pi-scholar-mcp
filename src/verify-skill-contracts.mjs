// Verifies that each converted skill documents the real tool contract: the
// field names its prose templates reference must exist in actual results, and
// the guard behaviours it claims must actually fire.
import { startHarness } from "./test-harness.mjs";

const harness = await startHarness();
const problems = [];

function check(label, condition, detail) {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || !detail ? "" : ` -> ${detail}`}`);
  if (!condition) problems.push(label);
}

// --- scholar-daily ---------------------------------------------------------
console.log("\n== scholar-daily ==");
{
  const daily = await harness.call("scholar_get_daily_context", {});
  check("context returns a result", !daily.isError, daily.text.slice(0, 200));
  const context = daily.json();
  check("context exposes date", typeof context.date === "string", JSON.stringify(Object.keys(context)));
  check(
    "context exposes an expired-quiz count",
    typeof context.expiredCount === "number",
    JSON.stringify(Object.keys(context)),
  );
  check("context exposes a maintenance flag", typeof context.maintenanceEnabled === "boolean", JSON.stringify(Object.keys(context)));
  check("context exposes a candidates array", Array.isArray(context.candidates), JSON.stringify(Object.keys(context)));
  console.log(`   guarded answer template: "Daily quiz guarded for ${context.date}. Expired prior quizzes: ${context.expiredCount}. No quiz was published."`);

  const publish = await harness.call("scholar_publish_daily", {
    status: "skipped",
    date: context.date,
    reason: "contract probe: verifying the maintenance guard rejects publication",
  });
  check("maintenance guard blocks publication", publish.isError, publish.text.slice(0, 200));
}

// --- scholar-extract -------------------------------------------------------
console.log("\n== scholar-extract ==");
{
  const extract = await harness.call("scholar_get_extract_context", {});
  check("empty inbox returns a bounded batch, not an error", !extract.isError, extract.text.slice(0, 200));
  const claims = extract.json().claims ?? [];
  check("batch is an array", Array.isArray(claims));
  if (claims.length > 0) {
    check("claim carries 1-based atom line endpoints", claims[0].atoms?.[0]?.startLine === 1, JSON.stringify(claims[0].atoms?.[0]));
    check(
      "claim carries a vault-relative extractedPath",
      typeof claims[0].extractedPath === "string" && !/^([A-Za-z]:|\/)/.test(claims[0].extractedPath),
      claims[0].extractedPath,
    );
  } else {
    console.log("   (inbox empty; claim shape checked by lifecycle-test)");
  }
}

// --- scholar-lint ----------------------------------------------------------
console.log("\n== scholar-lint ==");
{
  const status = await harness.call("scholar_status", {});
  check("scholar_status returns structured JSON", !status.isError && status.json() !== null, status.text.slice(0, 200));

  const context = await harness.call("scholar_get_lint_context", {});
  check("scholar_get_lint_context works", !context.isError, context.text.slice(0, 300));
  const parsed = context.json();
  check("lint context carries no requestId (server-side workflow key)", !parsed.workflowRequestId && !parsed.requestId, JSON.stringify(Object.keys(parsed)));
  check("lint context exposes scope/pages/issues", ["scope", "pages", "issues"].every((key) => key in parsed), JSON.stringify(Object.keys(parsed)));

  const record = (parsed.pages ?? []).find((entry) => entry.page?.status === "active");
  if (record) {
    const page = record.page;
    const body = String(record.markdown ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
    const stale = await harness.call("scholar_apply_lint", {
      kind: "update-page",
      pageId: page.pageId,
      expectedDigest: "0".repeat(64),
      body,
    });
    check("scholar_apply_lint rejects a stale digest", stale.isError, stale.text.slice(0, 160));

    const applied = await harness.call("scholar_apply_lint", {
      kind: "update-page",
      pageId: page.pageId,
      expectedDigest: page.digest,
      body,
    });
    check("scholar_apply_lint applies a guarded update-page", !applied.isError, applied.text.slice(0, 300));
  } else {
    console.log("   (no active page in a fresh vault; apply covered by lifecycle-test)");
  }

  const finish = await harness.call("scholar_finish_lint", {});
  check("scholar_finish_lint works with no arguments", !finish.isError, finish.text.slice(0, 300));

  if (record) {
    const afterFinish = await harness.call("scholar_apply_lint", {
      kind: "update-page",
      pageId: record.page.pageId,
      expectedDigest: record.page.digest,
      body: String(record.markdown ?? "").replace(/^---\n[\s\S]*?\n---\n?/, ""),
    });
    check("scholar_apply_lint after finish is rejected", afterFinish.isError, afterFinish.text.slice(0, 160));
  }

  const again = await harness.call("scholar_get_lint_context", {});
  check("a context request after finish is bounded", !again.isError, again.text.slice(0, 200));
  await harness.call("scholar_finish_lint", {});
}

// --- scholar-quiz-grader ---------------------------------------------------
console.log("\n== scholar-quiz-grader ==");
{
  const grading = await harness.call("scholar_get_grading_context", {});
  check("scholar_get_grading_context works", !grading.isError, grading.text.slice(0, 300));
  const parsed = grading.json();
  check("no sealed submission => no requestId (skill must stop)", !parsed.requestId, JSON.stringify(parsed).slice(0, 200));
  check("quiz is absent when nothing is queued", !parsed.quiz, JSON.stringify(parsed).slice(0, 200));
  console.log('   -> skill should report: "no sealed submission queued"');
}

harness.close();
console.log(`\n${problems.length === 0 ? "ALL SKILL CONTRACT CHECKS PASSED" : `${problems.length} PROBLEM(S)`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
