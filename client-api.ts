import { launch } from "puppeteer";

const endpoint = "https://www.facebook.com/ads/library/?id=1391552012715926";

const SEARCH_STRINGS = ["title", "body", "image_url"];

const main = async () => {
  const browser = await launch({ headless: false });
  const page = await browser.newPage();

  const matches: Array<{ url: string; found: string[] }> = [];

  page.on("response", async (response) => {
    const url = response.url();
    try {
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.includes("json") && !contentType.includes("text")) return;

      const text = await response.text();
      const found = SEARCH_STRINGS.filter((s) => text.includes(s));

      if (found.length > 0) {
        console.log(`\n[MATCH] ${url}`);
        console.log(`  Found: ${found.join(", ")}`);
        console.log(`  Response (first 500 chars): ${text.slice(0, 500)}`);
        matches.push({ url, found });
      }
    } catch {
      // ignore unreadable responses (binary, already consumed, etc.)
    }
  });

  console.log(`Opening: ${endpoint}`);
  await page.goto(endpoint, { waitUntil: "networkidle2", timeout: 60000 });

  // Click "See ad details" button if present
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("*"));
      const btn = buttons.find(
        (el) =>
          (el as HTMLElement).innerText?.trim() === "See ad details" &&
          ((el.tagName === "BUTTON") || (el as HTMLElement).getAttribute("role") === "button")
      ) as HTMLElement | undefined;
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      console.log('\n[ACTION] Clicked "See ad details" button.');
      // Wait a bit for any new network requests triggered by the click
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.log('\n[ACTION] "See ad details" button not found.');
    }
  } catch (err) {
    console.error('[ACTION] Error clicking "See ad details":', err);
  }

  if (matches.length === 0) {
    console.log("\n[RESULT] Nothing found — no responses contained the target strings.");
  } else {
    console.log(`\n[RESULT] ${matches.length} matching response(s) captured.`);
  }

  await browser.close();
};

const plainFetch = async () => {
    console.log(`\n[TEST] Performing plain fetch to ${endpoint}`);
    try {
        const response = await fetch(endpoint, {
            headers: {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
            },
        });
        const text = await response.text();

        const targetSequence = String.raw`"deeplink_ad_archive": `;
        const sequenceIndex = text.indexOf(targetSequence);

        if (sequenceIndex === -1) {
            console.log("[TEST] Target sequence not found in response.");
        } else {
            const snippet = text.slice(sequenceIndex, sequenceIndex + 200);
            console.log(`[TEST] Found target sequence in response:\n${snippet}`);
        }
    } catch (err) {
        console.error("[TEST] Error during plain fetch:", err);
    }
};

// await main().catch((err) => {
//   console.error("Fatal error:", err);
//   process.exit(1);
// });
await plainFetch();
