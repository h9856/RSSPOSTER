// 本機圖卡工具：讀 feed，每篇新文章產出一張直式圖卡與貼文，存到 out/。不上傳、不發文。
//
//   node --experimental-strip-types local/cards.ts <站台id> [--limit 5]
//       讀 feed，處理還沒做過的文章（最新的 limit 篇）
//   node --experimental-strip-types local/cards.ts <站台id> --list
//       只列出還沒做過的文章，挑稿用
//   node --experimental-strip-types local/cards.ts <站台id> --url <網址> [--url <網址> ...]
//       只做指定的幾篇
//   node --experimental-strip-types local/cards.ts --render <資料夾>
//       照資料夾裡的 meta.json 重畫圖卡（改完標題、裁切位置之後用）

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Site } from "../src/config.ts";
import { parseFeed, parseArticle, type FeedItem } from "../src/feed.ts";
import { renderCard, pickLayout, type Focus, type Layout } from "./card.ts";
import { writeCopy, draftCopy, checkCopy, type Copy } from "./copy.ts";

const OUT = path.resolve("out");

interface Meta {
  site: string;
  url: string;
  title: string;
  published: string | null;
  image: string;
  copy: Copy;
  /** 圖片裁切位置：auto／left／center／right／top */
  focus: Focus;
  /** cover 裁切填滿，framed 模糊底圖放原圖 */
  layout: Layout;
  /** true：文字是自動草稿還沒人工改過。手改完可以刪掉或改成 false */
  draft?: boolean;
  createdAt: string;
}

async function loadSites(): Promise<Site[]> {
  return JSON.parse(await readFile("sites.json", "utf8")) as Site[];
}

async function fetchArticle(url: string) {
  return parseArticle(await (await fetch(url, { headers: { "User-Agent": "RSSPoster/1.0" } })).text());
}

function slugOf(item: FeedItem): string {
  const seg = decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() ?? "");
  const clean = seg.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return clean || new URL(item.url).searchParams.get("p") || "post";
}

function siteStamp(site: Site, iso: string | null): { day: string; hm: string } {
  const d = new Date((iso ? Date.parse(iso) : Date.now()) + (site.utcOffset ?? 8) * 3600_000).toISOString();
  return { day: d.slice(0, 10), hm: d.slice(11, 16).replace(":", "") };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function draw(dir: string, meta: Meta): Promise<void> {
  const problem = checkCopy(meta.copy);
  if (problem) console.warn(`   注意：${problem}`);
  const sites = await loadSites();
  const site = sites.find((s) => s.id === meta.site);
  if (!site?.card) throw new Error(`sites.json 的 ${meta.site} 沒有 card 設定`);
  const card = await renderCard({
    image: await readFile(path.join(dir, "source.img")),
    lines: meta.copy.lines,
    label: meta.copy.label,
    footer: meta.copy.footer,
    style: site.card,
    focus: meta.focus,
    layout: meta.layout,
  });
  await writeFile(path.join(dir, "card.jpg"), card);
  await writeFile(path.join(dir, "post.txt"), `${meta.copy.post}\n${meta.url}\n`);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

interface RunOptions {
  limit: number;
  /** 只列出候選，不產圖 */
  list: boolean;
  /** 只處理這些網址（不受 limit 限制） */
  urls: string[];
}

async function processSite(siteId: string, opts: RunOptions): Promise<void> {
  const site = (await loadSites()).find((s) => s.id === siteId);
  if (!site) throw new Error(`sites.json 裡沒有 ${siteId}`);
  const useAi = Boolean(process.env.ANTHROPIC_API_KEY) && !process.argv.includes("--no-ai");

  const seenFile = path.join(OUT, site.id, "seen.json");
  const seen = new Set(await readJson<string[]>(seenFile, []));
  const exclude = new Set(site.excludeCategories ?? []);

  const res = await fetch(site.feed, { headers: { "User-Agent": "RSSPoster/1.0" } });
  if (!res.ok) throw new Error(`feed 讀取失敗 ${res.status}`);
  const candidates = parseFeed(await res.text())
    .filter((it) => !it.categories.some((c) => exclude.has(c)))
    .filter((it) => !seen.has(it.guid));

  if (opts.list) {
    for (const it of candidates) {
      const { day, hm } = siteStamp(site, it.published);
      console.log(`${day} ${hm}　[${it.categories.join("/")}]　${it.title}\n　　${it.url}`);
    }
    console.log(`共 ${candidates.length} 篇未處理`);
    return;
  }

  const norm = (u: string) => decodeURI(u).replace(/\/$/, "");
  const items = (
    opts.urls.length
      ? opts.urls.map((u) => {
          const it = candidates.find((c) => norm(c.url) === norm(u));
          if (!it) throw new Error(`feed 的未處理文章裡找不到 ${u}`);
          return it;
        })
      : candidates.slice(0, opts.limit)
  ).reverse(); // 舊的先做

  if (!useAi) console.log("不使用 AI：大標先用文章標題排草稿，請改 meta.json 後用 --render 重畫");

  if (items.length === 0) console.log(`[${site.id}] 沒有新文章`);
  for (const item of items) {
    console.log(`[${site.id}] ${item.title}`);
    try {
      const page = await fetchArticle(item.url);
      const imageUrl = page.image;
      if (!imageUrl) throw new Error("文章沒有 og:image");
      const image = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
      // feed 只有摘要時改用文章頁的全文
      const summary = page.text.length > item.summary.length ? page.text : item.summary;
      const copy = useAi ? await writeCopy(site, { title: item.title, summary }) : draftCopy(item);

      const { day, hm } = siteStamp(site, item.published);
      const dir = path.join(OUT, site.id, day, `${hm}-${slugOf(item)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "source.img"), image);
      const meta: Meta = {
        site: site.id,
        url: item.url,
        title: item.title,
        published: item.published,
        image: imageUrl,
        copy,
        focus: "auto",
        layout: await pickLayout(image),
        draft: !useAi,
        createdAt: new Date().toISOString(),
      };
      await draw(dir, meta);
      console.log(`   → ${path.relative(process.cwd(), dir)}（${meta.layout}）`);
    } catch (e) {
      console.error(`   失敗：${e instanceof Error ? e.message : e}`);
      continue; // 失敗的不記進 seen，下次重試
    }
    seen.add(item.guid);
    await mkdir(path.dirname(seenFile), { recursive: true });
    await writeFile(seenFile, JSON.stringify([...seen], null, 2));
  }
}

const args = process.argv.slice(2);
if (args[0] === "--render") {
  const dir = path.resolve(args[1] ?? ".");
  await draw(dir, await readJson<Meta>(path.join(dir, "meta.json"), null as unknown as Meta));
  console.log(`已重畫 ${path.relative(process.cwd(), dir)}`);
} else if (args[0]) {
  const i = args.indexOf("--limit");
  await processSite(args[0], {
    limit: i >= 0 ? Number(args[i + 1]) : 5,
    list: args.includes("--list"),
    urls: args.flatMap((a, j) => (a === "--url" && args[j + 1] ? [args[j + 1]] : [])),
  });
} else {
  console.log(
    "用法：cards.ts <站台id> [--limit 5] [--list] [--url <網址> ...] [--no-ai]　或　cards.ts --render <資料夾>",
  );
}
