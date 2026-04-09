import { launch, type Browser } from "puppeteer";
import { readFile, appendFile } from "node:fs/promises";

const ENDPOINT = "https://www.facebook.com/ads/library/?id=";
const GRAPH_API_JSONL = "./graph-api.jsonl";
const OUTPUT_JSONL = "./ads-client.jsonl";
const BATCH_SIZE = 24;

const jsonEndPosition = (html: string, startIndex: number): number => {
  const bracketStack: string[] = [];
  bracketStack.push("{");
  for (let i = startIndex + 1; i < html.length; i++) {
    const char = html[i];
    if (char === "{") bracketStack.push(char);
    if (char === "}") bracketStack.pop();
    if (bracketStack.length === 0) return i;
  }
  throw new Error("Matching closing brace not found.");
};

const extractPayload = async (
  browser: Browser,
  ad: { id: string; },
): Promise<{ id: string; data: unknown } | { id: string; error: string }> => {
  const page = await browser.newPage();
  try {
    await page.goto(`${ENDPOINT}${ad.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    
    // Wait for any post-load redirects (e.g. JS challenge) to fully settle
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});

    const html = await page.content();

    const match = /"deeplink_ad_archive"\s*:\s*\{/.exec(html);
    if (!match) {
      return { id: ad.id, error: "Target sequence not found" };
    }

    const jsonStartIndex = match.index + match[0].length - 1;
    const jsonEndIndex = jsonEndPosition(html, jsonStartIndex);
    const data = JSON.parse(html.slice(jsonStartIndex, jsonEndIndex + 1));
    return { id: ad.id, data };
  } catch (err) {
    return { id: ad.id, error: String(err) };
  } finally {
    await page.close();
  }
};

const main = async () => {
  const fileContent = await readFile(GRAPH_API_JSONL, "utf8");
  const allAds: { id: string; }[] = fileContent
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  console.log(`Loaded ${allAds.length} ads from ${GRAPH_API_JSONL}`);

  const browser = await launch({
    headless: true,
    protocolTimeout: 60_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--js-flags=--max-old-space-size=2048",
    ],
  });

  try {
    for (let i = 0; i < allAds.length; i += BATCH_SIZE) {
      const batch = allAds.slice(i, i + BATCH_SIZE);
      console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}: processing ads ${i + 1}–${i + batch.length} of ${allAds.length}`);

      const results = await Promise.all(batch.map((ad) => extractPayload(browser, ad)));

      const lines = results.map((r) => JSON.stringify({ ...r, timestamp: new Date().toISOString() })).join("\n") + "\n";
      await appendFile(OUTPUT_JSONL, lines, "utf8");

      const ok = results.filter((r) => !("error" in r)).length;
      const fail = results.length - ok;
      console.log(`  Done: ${ok} ok, ${fail} failed`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nAll batches complete. Results written to ${OUTPUT_JSONL}`);
};

await main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
