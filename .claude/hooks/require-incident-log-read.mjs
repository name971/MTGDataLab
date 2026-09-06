// PreToolUse(Edit|Write) hook: block edits to Supabase/R2/D1/daily-batch/Cloudflare Workers
// files until docs/incident-log.md has been Read this session (AGENTS.md rule, enforced in
// code per its own header: "文章に書くだけの再発防止策は次に活かされる保証が無い").
import { existsSync } from "node:fs";

const SENSITIVE =
  /\/(db|scripts|\.github\/workflows)\/|wrangler\.jsonc$|next\.config\.|open-next\.config\.|supabase|\/db[A-Z][A-Za-z]*\.ts$/i;

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const json = JSON.parse(input);
    const filePath = (json.tool_input?.file_path ?? "").replace(/\\/g, "/");
    const sessionId = json.session_id ?? "default";
    if (SENSITIVE.test(filePath) && !existsSync(`.claude/.hook-state/incident-log-read-${sessionId}`)) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Supabase/R2/D1/daily-batch/Cloudflare Workers関連ファイルです。docs/incident-log.mdを先にReadしてから作業してください（AGENTS.mdのルール）。",
          },
        }),
      );
    }
  } catch {
    // never block on a parse failure
  }
});
