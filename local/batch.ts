// 把一批圖卡排成一張總覽圖給人確認：每則標編號、預定時間、貼文全文。
//
//   node --experimental-strip-types local/batch.ts <輸出檔.jpg> <時間>=<資料夾> [<時間>=<資料夾> ...]
//   例：local/batch.ts out/news/2026-09-25/batch.jpg 09:00=out/news/2026-09-25/0712-foo 12:00=...
//
// 同時在每個資料夾的 meta.json 記下 slot（預定發文時間），並輸出同名 .md 文字版。

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadFont } from "./fonts.ts";

const COL_W = 540;
const CARD_H = 675;
const TEXT_H = 270;
const GAP = 24;

interface Entry {
  no: number;
  slot: string;
  dir: string;
  post: string;
  url: string;
  title: string;
}

async function caption(e: Entry): Promise<Buffer> {
  const h = (style: object, children: unknown) => ({ type: "div", props: { style: { display: "flex", ...style }, children } });
  const tree = h({ flexDirection: "column", width: COL_W, height: TEXT_H, padding: "14px 4px", color: "#eee", backgroundColor: "#16171c" }, [
    h({ fontSize: 30, fontWeight: 700, color: "#7cc4ff", marginBottom: 8 }, `#${e.no}　${e.slot}`),
    h({ fontSize: 22, lineHeight: 1.5, marginBottom: 10 }, e.post),
    h({ fontSize: 16, color: "#999", lineHeight: 1.4 }, e.title),
  ]);
  const text = `#0123456789:${e.slot}${e.post}${e.title}`;
  const svg = await satori(tree as never, {
    width: COL_W,
    height: TEXT_H,
    fonts: [
      { name: "Noto Sans TC", data: await loadFont(text, 500), weight: 500, style: "normal" },
      { name: "Noto Sans TC", data: await loadFont(text, 700), weight: 700, style: "normal" },
    ],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}

const [outFile, ...pairs] = process.argv.slice(2);
if (!outFile || pairs.length === 0) {
  console.log("用法：batch.ts <輸出檔.jpg> <時間>=<資料夾> ...");
  process.exit(1);
}

const entries: Entry[] = [];
for (const [i, pair] of pairs.entries()) {
  const eq = pair.indexOf("=");
  const slot = pair.slice(0, eq);
  const dir = path.resolve(pair.slice(eq + 1));
  const metaFile = path.join(dir, "meta.json");
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  meta.slot = slot;
  await writeFile(metaFile, JSON.stringify(meta, null, 2));
  entries.push({ no: i + 1, slot, dir, post: meta.copy.post, url: meta.url, title: meta.title });
}

const cols = Math.min(entries.length, 3);
const rows = Math.ceil(entries.length / cols);
const tiles = await Promise.all(
  entries.map(async (e, i) => {
    const card = await sharp(path.join(e.dir, "card.jpg")).resize(COL_W, CARD_H).toBuffer();
    const left = GAP + (i % cols) * (COL_W + GAP);
    const top = GAP + Math.floor(i / cols) * (CARD_H + TEXT_H + GAP);
    return [
      { input: card, left, top },
      { input: await caption(e), left, top: top + CARD_H },
    ];
  }),
);
await sharp({
  create: {
    width: cols * COL_W + (cols + 1) * GAP,
    height: rows * (CARD_H + TEXT_H) + (rows + 1) * GAP,
    channels: 3,
    background: "#0b0c10",
  },
})
  .composite(tiles.flat())
  .jpeg({ quality: 85 })
  .toFile(outFile);

const md = entries
  .map((e) => `#${e.no} ${e.slot}\n${e.post}\n${e.url}\n（原標題：${e.title}）\n資料夾：${path.relative(process.cwd(), e.dir)}`)
  .join("\n\n");
await writeFile(outFile.replace(/\.jpg$/, ".md"), md + "\n");
console.log(`總覽圖：${outFile}\n${md}`);
