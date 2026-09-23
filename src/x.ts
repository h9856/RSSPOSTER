import type { XCredentials } from "./config.ts";

/** X 的網址一律算 23 字 */
export const X_URL_LENGTH = 23;
export const X_MAX_WEIGHT = 280;

// twitter-text v3：這些範圍算 1，其餘（中日韓文字、emoji）算 2
const LIGHT_RANGES: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

export function xWeight(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    w += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
}

/** 內文加上換行與網址後的總長度 */
export function xPostWeight(text: string): number {
  return xWeight(text) + 1 + X_URL_LENGTH;
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** OAuth 1.0a 使用者授權標頭。JSON body 不列入簽章。 */
export async function oauthHeader(
  method: string,
  url: string,
  cred: XCredentials,
  nonce = crypto.randomUUID().replace(/-/g, ""),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): Promise<string> {
  const params: Record<string, string> = {
    oauth_consumer_key: cred.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: cred.accessToken,
    oauth_version: "1.0",
  };
  const u = new URL(url);
  const all: [string, string][] = [...Object.entries(params), ...u.searchParams.entries()];
  const paramString = all
    .map(([k, v]) => [pct(k), pct(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(paramString)].join("&");
  const signature = await hmacSha1(`${pct(cred.apiSecret)}&${pct(cred.accessSecret)}`, base);
  return (
    "OAuth " +
    Object.entries({ ...params, oauth_signature: signature })
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(", ")
  );
}

export class XError extends Error {
  status: number;
  /** true：稍後可重試（限流、伺服器錯誤） */
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const TWEETS_URL = "https://api.x.com/2/tweets";

export async function postToX(cred: XCredentials, text: string): Promise<string> {
  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: await oauthHeader("POST", TWEETS_URL, cred),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new XError(`X ${res.status}: ${body.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
  }
  const data = JSON.parse(body) as { data?: { id?: string } };
  if (!data.data?.id) throw new XError(`X 回應沒有貼文 id：${body.slice(0, 300)}`, res.status, false);
  return data.data.id;
}
