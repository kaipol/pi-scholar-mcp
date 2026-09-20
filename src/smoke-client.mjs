// Smoke test for the MCP transport and the guarded workflow lifecycle:
// initialize, status, the daily maintenance guard, and a lint context/finish pair.
import { startHarness } from "./test-harness.mjs";

const harness = await startHarness();
const problems = [];

function check(label, condition, detail) {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || !detail ? "" : ` -> ${detail}`}`);
  if (!condition) problems.push(label);
}

const status = await harness.call("scholar_status", {});
check("scholar_status returns ok", !status.isError && status.json().status === "ok", status.text.slice(0, 200));

const daily = await harness.call("scholar_get_daily_context", {});
check("daily context reports the maintenance guard", !daily.isError && daily.json().maintenanceEnabled === true, daily.text.slice(0, 200));

const guarded = await harness.call("scholar_publish_daily", {
  status: "skipped",
  date: daily.json().date,
  reason: "smoke test: the maintenance guard must reject publication",
});
check("publish is rejected while maintenance is enabled", guarded.isError, guarded.text.slice(0, 200));

const lint = await harness.call("scholar_get_lint_context", {});
check("lint context returns scope/pages/issues", !lint.isError && ["scope", "pages", "issues"].every((key) => key in lint.json()), lint.text.slice(0, 200));

const finish = await harness.call("scholar_finish_lint", {});
check("finish_lint completes", !finish.isError && finish.json().status === "completed", finish.text.slice(0, 200));

harness.close();
console.log(problems.length === 0 ? "\nMCP BRIDGE TEST PASSED" : `\n${problems.length} FAILURE(S)`);
process.exit(problems.length === 0 ? 0 : 1);
