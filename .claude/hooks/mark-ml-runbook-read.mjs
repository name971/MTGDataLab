// PostToolUse(Read) hook: when docs/ml-ranking-runbook.md is Read, mark this session as
// having done so, so require-ml-runbook-read.mjs can stop gating the ML ranking scripts.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const json = JSON.parse(input);
    const filePath = (json.tool_input?.file_path ?? "").replace(/\\/g, "/");
    const sessionId = json.session_id ?? "default";
    if (/docs\/ml-ranking-runbook\.md$/.test(filePath)) {
      const dir = ".claude/.hook-state";
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/ml-runbook-read-${sessionId}`, String(Date.now()));
    }
  } catch {
    // never block on a parse failure
  }
});
