import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.resolve(".cache/fonts");

/**
 * 從 Google Fonts 抓思源黑體（Noto Sans TC），只取 text 用到的字。
 * satori 不吃 woff2，所以用舊瀏覽器的 User-Agent 讓 Google 回 TrueType。
 */
export async function loadFont(text: string, weight: 500 | 700 | 900): Promise<Buffer> {
  const chars = [...new Set(text)].sort().join("");
  const key = createHash("sha1").update(`${weight}:${chars}`).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, `notosanstc-${weight}-${key}.ttf`);
  try {
    return await readFile(file);
  } catch {
    // 快取沒有就下載
  }

  const cssUrl =
    `https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@${weight}` +
    `&text=${encodeURIComponent(chars)}`;
  const css = await (await fetch(cssUrl, { headers: { "User-Agent": "Mozilla/4.0" } })).text();
  const url = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
  if (!url) throw new Error(`Google Fonts 沒有回傳 TrueType 字型：${css.slice(0, 200)}`);

  const font = Buffer.from(await (await fetch(url)).arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, font);
  return font;
}
