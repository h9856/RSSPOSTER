import type { Env } from "./config.ts";
import { loadSites } from "./config.ts";
import { runCycle, publishItem, type Item } from "./cycle.ts";
import { composePost } from "./compose.ts";
import { renderAdmin } from "./admin.ts";
import { X_MAX_WEIGHT, xPostWeight } from "./x.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  const h = req.headers.get("Authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [, pass] = atob(h.slice(6)).split(":");
  return pass === env.ADMIN_PASSWORD;
}

async function handleItem(req: Request, env: Env, id: number): Promise<Response> {
  const { action, text } = (await req.json()) as { action: string; text: string | null };
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
  if (!item) return json({ error: "找不到這篇" }, 404);
  const site = loadSites(env).find((s) => s.id === item.site);
  if (!site) return json({ error: `設定裡沒有站台 ${item.site}` }, 400);

  const newText = text?.trim() || item.text;
  if (newText && ["save", "approve", "now"].includes(action) && xPostWeight(newText) > X_MAX_WEIGHT) {
    return json({ error: `太長了：${xPostWeight(newText)} / ${X_MAX_WEIGHT}` }, 400);
  }

  switch (action) {
    case "save":
      await env.DB.prepare("UPDATE items SET text = ? WHERE id = ?").bind(newText, id).run();
      break;
    case "approve":
      if (!newText) return json({ error: "還沒有文案" }, 400);
      await env.DB.prepare("UPDATE items SET text = ?, status = 'ready', attempts = 0, error = NULL WHERE id = ?")
        .bind(newText, id)
        .run();
      break;
    case "skip":
      await env.DB.prepare("UPDATE items SET status = 'skipped' WHERE id = ?").bind(id).run();
      break;
    case "rewrite": {
      const t = await composePost(env, site, item);
      await env.DB.prepare("UPDATE items SET text = ?, error = NULL WHERE id = ?").bind(t, id).run();
      break;
    }
    case "now": {
      if (!newText) return json({ error: "還沒有文案" }, 400);
      try {
        const postId = await publishItem(env, site, { ...item, text: newText });
        await env.DB.prepare("UPDATE items SET text = ? WHERE id = ?").bind(newText, id).run();
        return json({ ok: true, postId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await env.DB.prepare("UPDATE items SET error = ? WHERE id = ?").bind(msg.slice(0, 500), id).run();
        return json({ error: msg }, 502);
      }
    }
    default:
      return json({ error: `不認得的動作 ${action}` }, 400);
  }
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) {
      return new Response("需要登入", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="rssposter"' } });
    }
    const url = new URL(req.url);
    const sites = loadSites(env);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await renderAdmin(env, sites, url.searchParams.get("site"));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      return json({ log: await runCycle(env, sites) });
    }
    const m = url.pathname.match(/^\/api\/items\/(\d+)$/);
    if (req.method === "POST" && m) return handleItem(req, env, Number(m[1]));

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCycle(env, loadSites(env)).then((log) => {
        if (log.length) console.log(log.join("\n"));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
