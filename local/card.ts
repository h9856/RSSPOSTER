import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { CardStyle } from "../src/config.ts";
import { loadFont } from "./fonts.ts";

export const CARD_W = 1080;
export const CARD_H = 1350;
/** 上方圖片區的高度，下面漸層接文字 */
const IMG_H = 900;
const BG = "#07080c";

/** 圖片裁切位置。auto 用 sharp 的注意力偵測找主體。 */
export type Focus = "auto" | "left" | "center" | "right" | "top";
/** cover：裁切填滿；framed：模糊底圖上放完整原圖（小圖、超寬圖用） */
export type Layout = "cover" | "framed";

export interface CardInput {
  image: Buffer;
  /** 標題，一個元素一行，2 到 3 行 */
  lines: string[];
  /** 標題上方的分類小字，例如「遊戲新聞」 */
  label: string;
  /** 底部品牌字右邊的文字，通常是作品名，可以空白 */
  footer: string;
  style: CardStyle;
  focus?: Focus;
  layout?: Layout;
}

/** 放大超過這個倍數就改用 framed，避免圖糊掉 */
const MAX_UPSCALE = 1.6;

export async function pickLayout(image: Buffer): Promise<Layout> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  if (!width || !height) return "framed";
  const scale = Math.max(CARD_W / width, IMG_H / height);
  return scale > MAX_UPSCALE || width / height > 2.2 ? "framed" : "cover";
}

const POSITION: Record<Focus, string | number> = {
  auto: sharp.strategy.attention,
  left: "left",
  center: "centre",
  right: "right",
  top: "top",
};

async function prepareImage(image: Buffer, layout: Layout, focus: Focus): Promise<string> {
  let out: Buffer;
  if (layout === "cover") {
    out = await sharp(image)
      .resize(CARD_W, IMG_H, { fit: "cover", position: POSITION[focus] })
      .jpeg({ quality: 92 })
      .toBuffer();
  } else {
    const { width = CARD_W } = await sharp(image).metadata();
    const backdrop = await sharp(image)
      .resize(CARD_W, IMG_H, { fit: "cover" })
      .blur(40)
      .modulate({ brightness: 0.45 })
      .toBuffer();
    const front = await sharp(image)
      .resize({
        width: Math.min(CARD_W - 80, Math.round(width * MAX_UPSCALE)),
        height: IMG_H - 180,
        fit: "inside",
      })
      .toBuffer();
    const meta = await sharp(front).metadata();
    out = await sharp(backdrop)
      .composite([
        {
          input: front,
          left: Math.round((CARD_W - meta.width!) / 2),
          // 稍微偏上，讓下方漸層不要吃掉原圖
          top: Math.round((IMG_H - meta.height!) / 2 - 40),
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();
  }
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

/** 全形字算 1，半形算 0.55，用來估一行的寬度 */
function lineUnits(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u0000-ɏ -⁯]/.test(ch) ? 0.55 : 1;
  return n;
}

function titleSize(lines: string[]): number {
  const longest = Math.max(...lines.map(lineUnits), 1);
  // 三行時字小一點，文字區才不會頂進圖片太多
  const max = lines.length >= 3 ? 104 : 124;
  return Math.max(64, Math.min(max, Math.floor(960 / longest)));
}

/**
 * 有字距的小字。satori 的 letterSpacing 遇到中文斷詞處會把兩個字疊在一起，
 * 所以不用 letterSpacing，改成一個字一個元素、自己算間距。空白換成較寬的間距。
 */
function spaced(text: string, style: Record<string, unknown>, tracking: number, wordGap: number): Node {
  const children: Node[] = [];
  let gap = 0;
  for (const ch of text.trim()) {
    if (/\s/.test(ch)) {
      gap = wordGap;
      continue;
    }
    children.push(h("div", { display: "flex", marginLeft: children.length ? gap : 0 }, ch));
    gap = tracking;
  }
  return h("div", { display: "flex", ...style }, children);
}

// satori 吃的是 React 元素形狀的物件，這裡直接手寫，不用 JSX
type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style, children, ...extra },
});

export async function renderCard(input: CardInput): Promise<Buffer> {
  const layout = input.layout ?? (await pickLayout(input.image));
  const img = await prepareImage(input.image, layout, input.focus ?? "auto");
  const size = titleSize(input.lines);
  const brand = input.style.brand;

  const logo = input.style.logo
    ? h("img", { position: "absolute", top: 56, right: 56, width: 132, height: 132 }, undefined, {
        src: `data:image/png;base64,${(await sharp(await readFile(input.style.logo)).resize(264, 264, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()).toString("base64")}`,
        width: 132,
        height: 132,
      })
    : h(
        "div",
        {
          position: "absolute",
          top: 56,
          right: 56,
          display: "flex",
          padding: "12px 22px",
          border: "3px solid rgba(255,255,255,0.9)",
          borderRadius: 999,
          color: "#fff",
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: 4,
          backgroundColor: "rgba(0,0,0,0.35)",
        },
        brand,
      );

  const tree = h(
    "div",
    {
      width: CARD_W,
      height: CARD_H,
      display: "flex",
      position: "relative",
      backgroundColor: BG,
      fontFamily: "Noto Sans TC",
    },
    [
      h("img", { position: "absolute", top: 0, left: 0, width: CARD_W, height: IMG_H }, undefined, {
        src: img,
        width: CARD_W,
        height: IMG_H,
      }),
      // 圖片下緣漸層到底色。三行標題會往上長，漸層跟著拉高
      h("div", {
        position: "absolute",
        top: IMG_H - (input.lines.length >= 3 ? 600 : 460),
        left: 0,
        width: CARD_W,
        height: (input.lines.length >= 3 ? 600 : 460) + 1,
        backgroundImage: `linear-gradient(to bottom, rgba(7,8,12,0) 0%, rgba(7,8,12,0.8) 50%, ${BG} 88%)`,
      }),
      logo,
      h(
        "div",
        {
          position: "absolute",
          left: 60,
          right: 60,
          bottom: 84,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        },
        [
          spaced(
            input.label,
            {
              color: input.style.accent,
              fontSize: 30,
              fontWeight: 700,
              marginBottom: 22,
              textShadow: "0 2px 12px rgba(0,0,0,0.8)",
            },
            14,
            30,
          ),
          ...input.lines.map((line) =>
            h(
              "div",
              {
                display: "flex",
                color: "#fff",
                fontSize: size,
                fontWeight: 900,
                lineHeight: 1.18,
                letterSpacing: -1,
                whiteSpace: "nowrap",
              },
              line,
            ),
          ),
          h(
            "div",
            {
              display: "flex",
              alignItems: "center",
              marginTop: 34,
              color: "rgba(255,255,255,0.85)",
              fontSize: 26,
              fontWeight: 700,
            },
            input.footer
              ? [
                  spaced(brand, {}, 6, 16),
                  h("div", { display: "flex", width: 3, height: 30, margin: "0 26px", backgroundColor: "rgba(255,255,255,0.85)" }),
                  spaced(input.footer, {}, 6, 16),
                ]
              : [spaced(brand, {}, 6, 16)],
          ),
        ],
      ),
    ],
  );

  const allText = [input.label, ...input.lines, brand, input.footer].join("");
  const [w700, w900] = await Promise.all([loadFont(allText, 700), loadFont(allText, 900)]);
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CARD_W,
    height: CARD_H,
    fonts: [
      { name: "Noto Sans TC", data: w700, weight: 700, style: "normal" },
      { name: "Noto Sans TC", data: w900, weight: 900, style: "normal" },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } }).render().asPng();
  return sharp(png).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
