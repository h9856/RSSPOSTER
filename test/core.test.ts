import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthHeader, xWeight, xPostWeight } from "../src/x.ts";
import { parseFeed } from "../src/feed.ts";
import { cleanup } from "../src/compose.ts";
import { siteDayStartUtc } from "../src/config.ts";

test("X 字數：英數算 1、中文算 2、網址固定 23", () => {
  assert.equal(xWeight("abc"), 3);
  assert.equal(xWeight("中文"), 4);
  assert.equal(xWeight("《魔物獵人》"), 12);
  assert.equal(xPostWeight("abc"), 3 + 1 + 23);
});

test("OAuth 1.0a 簽章符合 X 官方文件範例", async () => {
  const header = await oauthHeader(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
    {
      apiKey: "xvz1evFS4wEEPTGEFPHBog",
      apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    },
    "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    "1318622958",
  );
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test("讀 WordPress RSS", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>《測試》發售日公開 &amp; 預購開始</title><link>https://example.com/?p=1</link>
<pubDate>Tue, 23 Sep 2026 03:00:00 +0000</pubDate><guid isPermaLink="false">https://example.com/?p=1</guid>
<description><![CDATA[<p>摘要</p>]]></description>
<content:encoded><![CDATA[<p>第一段&#8230;</p><figure><img src="x"><figcaption>圖說</figcaption></figure><p>第二段</p>]]></content:encoded></item>
</channel></rss>`;
  const [it] = parseFeed(xml);
  assert.equal(it.title, "《測試》發售日公開 & 預購開始");
  assert.equal(it.url, "https://example.com/?p=1");
  assert.equal(it.summary, "第一段…\n第二段");
  assert.equal(it.published, "2026-09-23T03:00:00.000Z");
});

test("文案清理：拿掉引號、網址，破折號改逗號", () => {
  assert.equal(cleanup("「A——B https://x.co/abc」"), "A，B");
});

test("站台日的起點是 UTC+8 的午夜", () => {
  const site = { utcOffset: 8 } as Parameters<typeof siteDayStartUtc>[0];
  assert.equal(siteDayStartUtc(site, new Date("2026-09-23T17:00:00Z")), "2026-09-23T16:00:00.000Z");
  assert.equal(siteDayStartUtc(site, new Date("2026-09-23T15:00:00Z")), "2026-09-22T16:00:00.000Z");
});
