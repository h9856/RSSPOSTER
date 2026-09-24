export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ADMIN_PASSWORD: string;
  SITES: string;
  DRY_RUN?: string;
  CLAUDE_MODEL?: string;
}

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export interface Site {
  id: string;
  name: string;
  feed: string;
  /** 這個站的語氣說明，會接在共用寫作規則後面 */
  voice: string;
  /** 每個站台日最多發幾篇 */
  dailyMax: number;
  /** 兩篇之間至少隔幾分鐘 */
  minGapMinutes: number;
  /** 可發文時段 [開始, 結束)，站台時間的小時，24 代表午夜 */
  hours: [number, number];
  /** 文章發布超過幾小時還沒發出去就放棄 */
  maxAgeHours: number;
  /** true：文案寫好先停在 review，要到後台核准才會發 */
  review: boolean;
  /** 帶有這些分類或標籤名稱的文章不發 */
  excludeCategories?: string[];
  /** 站台時區，預設 UTC+8 */
  utcOffset?: number;
  x: XCredentials;
  /** 本機圖卡工具的版型設定 */
  card?: CardStyle;
}

export interface CardStyle {
  /** 圖卡上的品牌字，例如站名英文 */
  brand: string;
  /** 分類小字的顏色 */
  accent: string;
  /** 右上角標誌的檔案路徑（PNG／SVG），沒有就用品牌字 */
  logo?: string;
}

export function loadSites(env: Env): Site[] {
  const sites = JSON.parse(env.SITES) as Site[];
  const ids = new Set<string>();
  for (const s of sites) {
    if (!s.id || !s.feed) throw new Error("SITES 每一站都要有 id 與 feed");
    if (ids.has(s.id)) throw new Error(`SITES 的 id 重複：${s.id}`);
    ids.add(s.id);
  }
  return sites;
}

export function isDryRun(env: Env): boolean {
  return env.DRY_RUN !== "0";
}

/** 站台當地時間（用 UTC 欄位讀，避免 Worker 所在地影響） */
export function siteNow(site: Site, now = new Date()): Date {
  return new Date(now.getTime() + (site.utcOffset ?? 8) * 3600_000);
}

/** 站台當日 00:00 對應的 UTC ISO 字串，用來算今天發了幾篇 */
export function siteDayStartUtc(site: Site, now = new Date()): string {
  const local = siteNow(site, now);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - (site.utcOffset ?? 8) * 3600_000).toISOString();
}
