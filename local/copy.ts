import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Site } from "../src/config.ts";
import { WRITING_RULES, cleanup } from "../src/compose.ts";
import { X_MAX_WEIGHT, xPostWeight } from "../src/x.ts";

export const CopySchema = z.object({
  post: z.string().describe("社群貼文內文，不含網址"),
  lines: z.array(z.string()).describe("圖卡大標題，一個元素一行"),
  label: z.string().describe("圖卡分類小字"),
  footer: z.string().describe("圖卡底部的作品名或主題，沒有就空字串"),
});
export type Copy = z.infer<typeof CopySchema>;

const SYSTEM = `你替網路媒體同時寫兩樣東西：一則社群貼文，以及一張直式新聞圖卡上的文字。

社群貼文（post）：
- 不超過 90 個中文字，兩句以內。不要附網址。

圖卡（lines、label、footer）：
- lines 是圖卡大標題，2 到 3 行，每行不超過 9 個全形字（英數兩個算一個字）。全部加起來 18 字以內。
- 大標題要一眼看懂發生什麼事，只留最關鍵的事實：誰、做了什麼、最重要的一個數字或日期。不用完整句子，不加標點結尾。
- 斷行要斷在詞的邊界，不能把一個詞或作品名拆到兩行。作品名太長就用文章裡常見的簡稱，或只放在 footer。
- label 是 2 到 6 字的分類，例如：遊戲新聞、新作情報、限時免費、兌換碼、銷量、改版、硬體。
- footer 是作品名或品牌名（不加《》），沒有明確主角就給空字串。

兩者共同規則：
${WRITING_RULES}`;

const units = (s: string) => [...s].reduce((n, ch) => n + (/[\u0000-ɏ]/.test(ch) ? 0.5 : 1), 0);

export function checkCopy(c: Copy): string | null {
  if (c.lines.length < 2 || c.lines.length > 3) return `大標題要 2 到 3 行，現在是 ${c.lines.length} 行`;
  const long = c.lines.find((l) => units(l) > 9.5);
  if (long) return `「${long}」超過 9 個字`;
  if (xPostWeight(c.post) > X_MAX_WEIGHT) return "貼文太長";
  return null;
}

/**
 * 不呼叫 AI 的草稿：大標用文章標題照詞界斷行（最多 3 行，放不下的截掉），
 * 分類取 feed 的第一個分類，底部取標題裡第一個《》。給手填流程當起點。
 */
export function draftCopy(item: { title: string; categories: string[] }): Copy {
  const segments = [...new Intl.Segmenter("zh-Hant", { granularity: "word" }).segment(item.title)].map(
    (s) => s.segment,
  );
  // 《》【】內的名稱不拆開，數字和後面的單位（9月、22日、100萬）黏在一起
  const PAIRS: Record<string, string> = { "《": "》", "【": "】" };
  const words: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const close = PAIRS[segments[i]];
    if (close) {
      const end = segments.indexOf(close, i);
      if (end > i) {
        words.push(segments.slice(i, end + 1).join(""));
        i = end;
        continue;
      }
    }
    const prev = words[words.length - 1];
    if (prev && /[0-9０-９]$/.test(prev) && /^[年月日週周萬億折%％倍位名款]/.test(segments[i])) {
      words[words.length - 1] = prev + segments[i];
      continue;
    }
    words.push(segments[i]);
  }

  const lines: string[] = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (units(cur + w) <= 9 || cur.trim() === "") lines[lines.length - 1] = cur + w;
    else if (lines.length < 3) lines.push(w.trimStart());
    else break;
  }

  return {
    post: item.title,
    lines: lines.map((l) => l.trim()).filter(Boolean),
    label: item.categories[0] ?? "",
    footer: item.title.match(/《([^》]+)》/)?.[1] ?? "",
  };
}

export async function writeCopy(site: Site, item: { title: string; summary: string }): Promise<Copy> {
  const client = new Anthropic();
  const article = `標題：${item.title}\n\n內文：\n${item.summary.slice(0, 3500)}`;
  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.beta.messages.parse({
      model: process.env.CLAUDE_MODEL || "claude-opus-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(CopySchema) },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `站台說明（${site.name}）：\n${site.voice}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `請替這篇文章寫貼文與圖卡文字。${feedback}\n\n${article}` }],
    });
    if (response.stop_reason === "refusal") throw new Error("Claude 拒絕為這篇寫文案");
    const out = response.parsed_output;
    if (!out) continue;

    const copy: Copy = {
      post: cleanup(out.post),
      lines: out.lines.map((l) => cleanup(l).replace(/[，。、！]$/, "")).filter(Boolean),
      label: cleanup(out.label),
      footer: cleanup(out.footer).replace(/^《|》$/g, ""),
    };
    const problem = checkCopy(copy);
    if (!problem) return copy;
    feedback = `\n上一版的問題：${problem}。請修正。`;
  }
  throw new Error("兩次都沒有寫出符合長度的圖卡文字");
}
