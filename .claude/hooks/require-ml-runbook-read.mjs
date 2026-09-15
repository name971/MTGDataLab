// PreToolUse(Bash) hook: block running ml/fetch_data.py or ml/predict_and_publish.py
// until docs/ml-ranking-runbook.md has been Read this session. This automation was
// previously auto-scheduled via GitHub Actions and got reverted back to manual execution
// (it kept failing), so the runbook's prerequisite checks/order/troubleshooting steps
// need to actually be followed each time rather than relied on from memory
// (docs/ml-ranking-runbook.md, 2026-09-15).
import { existsSync } from "node:fs";

const ML_RANKING_SCRIPT = /\bml\/(fetch_data|predict_and_publish)\.py\b/;

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const json = JSON.parse(input);
    const command = json.tool_input?.command ?? "";
    const sessionId = json.session_id ?? "default";
    if (ML_RANKING_SCRIPT.test(command) && !existsSync(`.claude/.hook-state/ml-runbook-read-${sessionId}`)) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "注目カードランキングの手動実行手順です。docs/ml-ranking-runbook.mdを先にReadしてから実行してください。",
          },
        }),
      );
    }
  } catch {
    // never block on a parse failure
  }
});
