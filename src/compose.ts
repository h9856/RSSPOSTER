import Anthropic from "@anthropic-ai/sdk";
import type { Env, Site } from "./config.ts";
import { X_MAX_WEIGHT, xPostWeight } from "./x.ts";

// 共用寫作規則放最前面且固定不變，讓提示快取吃得到
const RULES = `你替網路媒體寫 X（Twitter）貼文。讀者是台灣人，一律用繁體中文與台灣用語。

規則：
- 只輸出貼文內文本身。不要加引號、不要加說明、不要附網址（系統會自動接在最後）。
- 全文不超過 90 個中文字。兩句以內最好。
- 開頭就是事實陳述，主詞放最前面。不要用問句、懸念、「你知道嗎」「竟然」「震驚」這類鉤子。
- 只寫文章裡有的資訊，不要推測、不要補文章沒寫的數字或日期。
- 不要用破折號「——」，改用逗號或句號。
- 不要自稱本站、小編，不要寫「點擊連結」「詳見內文」這類導引句。
- 不加 emoji。hashtag 最多一個，只有站台說明要求時才加。
- 遊戲、商品、作品名稱用文章裡的寫法，作品名用《》。`;

const client = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

async function ask(env: Env, site: Site, prompt: string): Promise<string> {
  const response = await client(env).beta.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: [
      { type: "text", text: RULES },
      { type: "text", text: `站台說明（${site.name}）：\n${site.voice}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude 拒絕為這篇寫文案");
  const text = response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return cleanup(text);
}

export function cleanup(text: string): string {
  return text
    .replace(/^["「『“]+|["」』”]+$/g, "")
    .replace(/\s*(——|—|──)\s*/g, "，")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** 寫一篇貼文。太長就請它重寫一次，還是太長就退回用標題。 */
export async function composePost(
  env: Env,
  site: Site,
  item: { title: string; summary: string },
): Promise<string> {
  const article = `標題：${item.title}\n\n內文：\n${item.summary.slice(0, 3500)}`;
  let text = await ask(env, site, `請替這篇文章寫一則 X 貼文。\n\n${article}`);
  if (text && xPostWeight(text) <= X_MAX_WEIGHT) return text;

  text = await ask(
    env,
    site,
    `請替這篇文章寫一則 X 貼文。上一版太長，這次控制在 60 個中文字以內。\n\n${article}`,
  );
  if (text && xPostWeight(text) <= X_MAX_WEIGHT) return text;
  return item.title;
}
