/**
 * GitHub Actionsのrun状況をまとめて確認する調査用CLI。今日、run一覧・ステップ確認・
 * 失敗ステップのログ取得のためのcurl/nodeワンライナーを何度も書き直していたため、
 * 使い回せる形にした（2026-08-25）。
 *
 * 実行: GH_TOKEN=... node scripts/gh-run-status.mjs [<runId> | <workflow.yml>]
 *   引数省略: 全ワークフローの最新runを一覧表示
 *   数字のみ: そのrun IDの詳細（ステップ一覧、失敗ステップがあればログの該当箇所）
 *   ワークフローファイル名: そのワークフローの最新run
 */

const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO ?? "name971/MTGDataLab";

if (!GH_TOKEN) {
  console.error("GH_TOKEN を設定してください（.env.local参照）");
  process.exit(1);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listAllWorkflowsLatestRuns() {
  const { workflows } = await gh("/actions/workflows?per_page=50");
  for (const wf of workflows) {
    const { workflow_runs } = await gh(`/actions/workflows/${wf.id}/runs?per_page=1`);
    const r = workflow_runs[0];
    if (!r) {
      console.log(`${wf.name}: run無し`);
      continue;
    }
    console.log(`${wf.name}: run ${r.id}  ${r.status}/${r.conclusion ?? "-"}  ${r.created_at}`);
  }
}

async function showRunDetail(runId) {
  const { jobs } = await gh(`/actions/runs/${runId}/jobs`);
  for (const job of jobs) {
    console.log(`job "${job.name}": ${job.status}/${job.conclusion ?? "-"}`);
    for (const step of job.steps) {
      const mark = step.conclusion === "failure" ? "  <-- 失敗" : "";
      console.log(`  ${step.number} ${step.name}: ${step.status}/${step.conclusion ?? "-"}${mark}`);
    }

    const failedStep = job.steps.find((s) => s.conclusion === "failure");
    if (failedStep) {
      console.log(`\n失敗ステップ「${failedStep.name}」のログ末尾:`);
      const logRes = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
      });
      const text = await logRes.text();
      const lines = text.split("\n");
      console.log(lines.slice(-40).join("\n"));
    }
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    await listAllWorkflowsLatestRuns();
  } else if (/^\d+$/.test(arg)) {
    await showRunDetail(arg);
  } else {
    const { workflow_runs } = await gh(`/actions/workflows/${arg}/runs?per_page=1`);
    if (!workflow_runs[0]) {
      console.error(`${arg} のrunが見つかりません`);
      process.exit(1);
    }
    console.log(`最新run: ${workflow_runs[0].id}  ${workflow_runs[0].status}/${workflow_runs[0].conclusion ?? "-"}`);
    await showRunDetail(workflow_runs[0].id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
