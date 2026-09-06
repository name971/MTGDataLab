// PostToolUse(Read) hook: when docs/incident-log.md is Read, mark this session as
// having done so, so require-incident-log-read.mjs can stop gating sensitive edits.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const json = JSON.parse(input);
    const filePath = (json.tool_input?.file_path ?? "").replace(/\\/g, "/");
    const sessionId = json.session_id ?? "default";
    if (/docs\/incident-log\.md$/.test(filePath)) {
      const dir = ".claude/.hook-state";
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/incident-log-read-${sessionId}`, String(Date.now()));
    }
  } catch {
    // never block on a parse failure
  }
});
