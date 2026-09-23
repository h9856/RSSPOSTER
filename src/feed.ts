export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  summary: string;
  published: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  return m ? unwrapCdata(m[1]).trim() : null;
}

function attr(block: string, name: string, attribute: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function toIso(date: string | null): string | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** 讀 RSS 2.0 或 Atom。只取發文需要的欄位，內文優先取全文。 */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const isAtom = /<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) ?? [];

  for (const b of blocks) {
    const url = isAtom
      ? attr(b, "link", "href")
      : decodeEntities(tag(b, "link") ?? "");
    if (!url) continue;
    const guid = decodeEntities(tag(b, isAtom ? "id" : "guid") ?? url);
    const title = stripHtml(tag(b, "title") ?? "");
    const body =
      tag(b, "content:encoded") ?? tag(b, "content") ?? tag(b, "description") ?? tag(b, "summary") ?? "";
    items.push({
      guid,
      url,
      title,
      summary: stripHtml(body).slice(0, 4000),
      published: toIso(tag(b, isAtom ? "published" : "pubDate") ?? tag(b, "updated")),
    });
  }
  return items;
}
