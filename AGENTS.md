<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Before touching Supabase / R2 / D1 / daily batch / Cloudflare Workers code

Read `docs/incident-log.md` first, every time — not "if you remember to." Past incidents (2026-08-15, 2026-08-17) happened specifically because this instruction lived only inside that file and was never seen unless someone thought to open it. This line exists in AGENTS.md, which loads automatically every session, so there is no "forgot to check" excuse left. After fixing a new bug in this area, append an entry to that file, including a "can this be enforced in code, not just written down" check per its own header rule.
