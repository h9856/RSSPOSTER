import type { Env, Site } from "./config.ts";
import { isDryRun, siteDayStartUtc, siteNow } from "./config.ts";
import { parseArticle, parseFeed } from "./feed.ts";
import { composePost } from "./compose.ts";
import { postToX, XError } from "./x.ts";

export interface Item {
  id: number;
  site: string;
  guid: string;
  url: string;
  title: string;
  summary: string;
  published: string | null;
  found_at: string;
  status: string;
  text: string | null;
  attempts: number;
  error: string | null;
  posted_at: string | null;
  post_id: string | null;
}

const MAX_ATTEMPTS = 3;
/** 每輪每站最多寫幾篇文案，避免一次卡太久 */
const COMPOSE_PER_RUN = 3;

/** 讀 feed，新文章寫進佇列。第一次讀到的站台，現有文章全部標成 skipped，不回頭補發。 */
export async function ingest(env: Env, site: Site, log: string[]): Promise<void> {
  const res = await fetch(site.feed, {
    headers: { "User-Agent": "RSSPoster/1.0", Accept: "application/rss+xml, application/xml, text/xml" },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) {
    log.push(`[${site.id}] feed 讀取失敗 ${res.status}`);
    return;
  }
  const exclude = new Set(site.excludeCategories ?? []);
  const items = parseFeed(await res.text()).filter((it) => !it.categories.some((c) => exclude.has(c)));
  const known = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE site = ?").bind(site.id).first<{ n: number }>();
  const firstRun = (known?.n ?? 0) === 0;
  const now = new Date().toISOString();

  const stmts = items.map((it) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO items (site, guid, url, title, summary, published, found_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(site.id, it.guid, it.url, it.title, it.summary, it.published, now, firstRun ? "skipped" : "new"),
  );
  if (stmts.length === 0) return;
  const results = await env.DB.batch(stmts);
  const added = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (added > 0) log.push(`[${site.id}] 新增 ${added} 篇${firstRun ? "（首次讀取，全部略過不發）" : ""}`);
}

/** 放棄太舊的文章 */
export async function expire(env: Env, site: Site): Promise<void> {
  const cutoff = new Date(Date.now() - site.maxAgeHours * 3600_000).toISOString();
  await env.DB.prepare(
    `UPDATE items SET status = 'expired'
     WHERE site = ? AND status IN ('new', 'review', 'ready')
       AND COALESCE(published, found_at) < ?`,
  )
    .bind(site.id, cutoff)
    .run();
}

export async function compose(env: Env, site: Site, log: string[]): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM items WHERE site = ? AND status = 'new' AND attempts < ? ORDER BY found_at LIMIT ?`,
  )
    .bind(site.id, MAX_ATTEMPTS, COMPOSE_PER_RUN)
    .all<Item>();

  for (const item of results) {
    try {
      // feed 只給摘要的站，改讀文章頁全文
      if (item.summary.length < 400) {
        const page = await fetch(item.url, { headers: { "User-Agent": "RSSPoster/1.0" } });
        if (page.ok) {
          const { text } = parseArticle(await page.text());
          if (text.length > item.summary.length) {
            item.summary = text;
            await env.DB.prepare("UPDATE items SET summary = ? WHERE id = ?").bind(text, item.id).run();
          }
        }
      }
      const text = await composePost(env, site, item);
      await env.DB.prepare("UPDATE items SET text = ?, status = ?, error = NULL WHERE id = ?")
        .bind(text, site.review ? "review" : "ready", item.id)
        .run();
      log.push(`[${site.id}] 文案完成 #${item.id} ${item.title}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare(
        `UPDATE items SET attempts = attempts + 1, error = ?,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
         WHERE id = ?`,
      )
        .bind(msg.slice(0, 500), MAX_ATTEMPTS, item.id)
        .run();
      log.push(`[${site.id}] 文案失敗 #${item.id}：${msg}`);
    }
  }
}

/** 這一站現在能不能發，不能的話回傳原因 */
export async function blockedReason(env: Env, site: Site, now = new Date()): Promise<string | null> {
  const hour = siteNow(site, now).getUTCHours();
  const [start, end] = site.hours;
  if (hour < start || hour >= end) return `不在發文時段（站台時間 ${hour} 點）`;

  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE site = ? AND status IN ('posted', 'dryrun') AND posted_at >= ?",
  )
    .bind(site.id, siteDayStartUtc(site, now))
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= site.dailyMax) return `今天已發滿 ${site.dailyMax} 篇`;

  const last = await env.DB.prepare(
    "SELECT MAX(posted_at) AS t FROM items WHERE site = ? AND status IN ('posted', 'dryrun')",
  )
    .bind(site.id)
    .first<{ t: string | null }>();
  if (last?.t) {
    const wait = Date.parse(last.t) + site.minGapMinutes * 60_000 - now.getTime();
    if (wait > 0) return `距離上一篇未滿 ${site.minGapMinutes} 分鐘`;
  }
  return null;
}

export async function publishItem(env: Env, site: Site, item: Item): Promise<string> {
  const full = `${item.text}\n${item.url}`;
  if (isDryRun(env)) {
    await env.DB.prepare("UPDATE items SET status = 'dryrun', posted_at = ?, error = NULL WHERE id = ?")
      .bind(new Date().toISOString(), item.id)
      .run();
    return "dry-run";
  }
  const id = await postToX(site.x, full);
  await env.DB.prepare("UPDATE items SET status = 'posted', posted_at = ?, post_id = ?, error = NULL WHERE id = ?")
    .bind(new Date().toISOString(), id, item.id)
    .run();
  return id;
}

/** 每輪每站最多發一篇，發最早進佇列的 */
export async function publish(env: Env, site: Site, log: string[]): Promise<void> {
  const reason = await blockedReason(env, site);
  if (reason) return;

  const item = await env.DB.prepare(
    "SELECT * FROM items WHERE site = ? AND status = 'ready' ORDER BY COALESCE(published, found_at) LIMIT 1",
  )
    .bind(site.id)
    .first<Item>();
  if (!item) return;

  try {
    const id = await publishItem(env, site, item);
    log.push(`[${site.id}] 已發 #${item.id} → ${id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retry = e instanceof XError && e.retryable;
    await env.DB.prepare(
      `UPDATE items SET attempts = attempts + 1, error = ?,
         status = CASE WHEN ? = 0 OR attempts + 1 >= ? THEN 'failed' ELSE status END
       WHERE id = ?`,
    )
      .bind(msg.slice(0, 500), retry ? 1 : 0, MAX_ATTEMPTS, item.id)
      .run();
    log.push(`[${site.id}] 發文失敗 #${item.id}：${msg}`);
  }
}

export async function runCycle(env: Env, sites: Site[]): Promise<string[]> {
  const log: string[] = [];
  for (const site of sites) {
    try {
      await ingest(env, site, log);
      await expire(env, site);
      await compose(env, site, log);
      await publish(env, site, log);
    } catch (e) {
      log.push(`[${site.id}] 錯誤：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return log;
}
