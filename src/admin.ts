import type { Env, Site } from "./config.ts";
import { isDryRun } from "./config.ts";
import { blockedReason, type Item } from "./cycle.ts";
import { xPostWeight, X_MAX_WEIGHT } from "./x.ts";

const STATUS_LABEL: Record<string, string> = {
  new: "待寫文案",
  review: "待核准",
  ready: "待發",
  posted: "已發",
  dryrun: "空跑",
  skipped: "略過",
  expired: "過期",
  failed: "失敗",
};

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(iso: string | null, site?: Site): string {
  if (!iso) return "";
  const d = new Date(Date.parse(iso) + (site?.utcOffset ?? 8) * 3600_000);
  return d.toISOString().slice(5, 16).replace("T", " ");
}

export async function renderAdmin(env: Env, sites: Site[], filter: string | null): Promise<string> {
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const where = filter ? "WHERE site = ?" : "";
  const stmt = env.DB.prepare(
    `SELECT * FROM items ${where}
     ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
              COALESCE(posted_at, found_at) DESC
     LIMIT 150`,
  );
  const { results } = await (filter ? stmt.bind(filter) : stmt).all<Item>();

  const summaries = await Promise.all(
    sites.map(async (s) => {
      const reason = await blockedReason(env, s);
      return `<a class="chip${filter === s.id ? " on" : ""}" href="?site=${esc(s.id)}">${esc(s.name)}<small>${esc(reason ?? "可發文")}</small></a>`;
    }),
  );

  const rows = results
    .map((it) => {
      const site = siteMap.get(it.site);
      const editable = ["review", "ready", "failed", "new"].includes(it.status);
      const weight = it.text ? xPostWeight(it.text) : 0;
      return `<article class="item s-${esc(it.status)}" data-id="${it.id}">
  <header>
    <span class="badge">${esc(STATUS_LABEL[it.status] ?? it.status)}</span>
    <span class="site">${esc(site?.name ?? it.site)}</span>
    <time>${esc(fmt(it.posted_at ?? it.published ?? it.found_at, site))}</time>
  </header>
  <a class="title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
  ${
    editable
      ? `<textarea rows="3">${esc(it.text)}</textarea>
  <div class="bar"><span class="count ${weight > X_MAX_WEIGHT ? "over" : ""}">${weight} / ${X_MAX_WEIGHT}</span>
    <button data-act="save">存檔</button>
    ${it.status === "review" || it.status === "failed" ? `<button data-act="approve" class="primary">核准排入</button>` : ""}
    <button data-act="now">立即發</button>
    <button data-act="rewrite">重寫</button>
    <button data-act="skip" class="ghost">略過</button>
  </div>`
      : `<p class="text">${esc(it.text)}</p>${it.post_id && it.post_id !== "dry-run" ? `<a class="link" href="https://x.com/i/status/${esc(it.post_id)}" target="_blank" rel="noopener">看貼文</a>` : ""}`
  }
  ${it.error ? `<p class="err">${esc(it.error)}</p>` : ""}
</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSS Poster</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1b1b1b;--mut:#6b6b6b;--line:#e2e2de;--acc:#1d6fe0;--warn:#b3261e;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--fg:#ececec;--mut:#9a9a9a;--line:#333;--acc:#6aa5ff;--warn:#ff8a80;--ok:#81c784}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"Noto Sans TC",sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 4px}.mode{color:var(--mut);margin:0 0 12px}.mode b{color:var(--warn)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.chip{display:flex;flex-direction:column;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);text-decoration:none}
.chip.on{border-color:var(--acc)}.chip small{color:var(--mut);font-size:12px}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px}
.item header{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--mut)}
.badge{padding:1px 8px;border-radius:99px;background:var(--line);color:var(--fg)}
.s-review .badge{background:var(--acc);color:#fff}.s-posted .badge{background:var(--ok);color:#fff}.s-failed .badge{background:var(--warn);color:#fff}
.title{display:block;margin:6px 0;color:var(--fg);font-weight:600;text-decoration:none}
textarea{width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
.count{font-size:12px;color:var(--mut);margin-right:auto}.count.over{color:var(--warn);font-weight:600}
button{font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.ghost{color:var(--mut)}
.text{margin:0;white-space:pre-wrap}.err{color:var(--warn);font-size:13px;margin:6px 0 0}.link{font-size:13px}
.top{display:flex;gap:8px;align-items:center}.top button{margin-left:auto}
</style></head><body><main>
<div class="top"><h1>RSS Poster</h1><button id="run">立刻跑一輪</button></div>
<p class="mode">${isDryRun(env) ? "<b>空跑模式</b>：只寫文案，不會真的發到 X。" : "正式模式：到時間會發到 X。"}</p>
<nav class="chips"><a class="chip${filter ? "" : " on"}" href="?">全部<small>${sites.length} 站</small></a>${summaries.join("")}</nav>
${rows || "<p>佇列是空的。</p>"}
</main>
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "run") { b.disabled = true; const r = await fetch("api/run", {method:"POST"}); alert((await r.json()).log.join("\\n") || "沒有變動"); location.reload(); return; }
  const card = b.closest(".item"); const act = b.dataset.act; if (!card || !act) return;
  if (act === "now" && !confirm("現在就發這篇？")) return;
  const ta = card.querySelector("textarea");
  b.disabled = true;
  const r = await fetch("api/items/" + card.dataset.id, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({action: act, text: ta ? ta.value : null})});
  const j = await r.json(); if (!r.ok) alert(j.error || "失敗");
  location.reload();
});
</script>
</body></html>`;
}
