import {
  type FileHandle,
  open as fopen,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import assert from "node:assert";
import process, { stdout } from "node:process";
import { setTimeout as setTimeoutP } from "node:timers/promises";

import { type Browser, launch } from "puppeteer";
import { adLibraryResponseSchema } from "./validator.js";

// --- Configuration & Constants ---
const GRAPH_API_BASE_URL = "https://graph.facebook.com/v24.0/ads_archive";
const SNAPSHOT_BASE_URL = "https://www.facebook.com/ads/archive/render_ad";

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
assert.ok(ACCESS_TOKEN, "ACCESS_TOKEN must be set in environment variables");

// --- Types ---
interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

type PageStatus = "unprocessed" | "in_progress" | "processed";

interface PageState {
  pageId: string;
  currentUrl: string | null;
  status: PageStatus;
}

interface GraphApiFetchResult {
  ids: string[];
  nextUrl: string | null;
}

// --- Utility Functions ---

const extractLimit = (url: string): number => {
  const urlObj = new URL(url);
  const limit = urlObj.searchParams.get("limit");
  return limit ? Number.parseInt(limit, 10) : 2000;
};

const updateLimit = (url: string, newLimit: number): string => {
  const urlObj = new URL(url);
  urlObj.searchParams.set("limit", newLimit.toString());
  return urlObj.toString();
};

const appendIdsToGraphApiJsonl = async (filePath: string, newIds: string[]) => {
  if (newIds.length === 0) return;
  const content = newIds.map((id) => JSON.stringify({ id })).join("\n") + "\n";
  await appendFile(filePath, content, "utf8");
};

// --- Step 1: Initialization ---
const initializePages = async (
  csvPath: string,
  pagesPath: string,
): Promise<PageState[]> => {
  let existingPages: PageState[] = [];
  try {
    const content = await readFile(pagesPath, "utf8");
    existingPages = JSON.parse(content);
    if (existingPages.length > 0) {
      console.log(
        `Loaded ${existingPages.length} existing pages from ${pagesPath}`,
      );
      return existingPages;
    }
  } catch {
    console.log("No existing pages found, creating new ones from CSV.");
  }

  const csvContent = await readFile(csvPath, "utf8");
  const targetAccounts = csvContent
    .split("\n")
    .slice(1) // Skip header
    .map((line) => line.trim())
    .filter(Boolean);

  const pages: PageState[] = targetAccounts.map((pageId) => {
    const params = new URLSearchParams({
      ad_type: "ALL",
      ad_active_status: "ALL",
      search_page_ids: pageId,
      ad_reached_countries: "['']",
      limit: "2000",
      fields: "id",
      access_token: ACCESS_TOKEN,
    });

    return {
      pageId,
      currentUrl: `${GRAPH_API_BASE_URL}?${params.toString()}`,
      status: "unprocessed",
    };
  });

  await writeFile(pagesPath, JSON.stringify(pages, null, 2));
  return pages;
};

// --- Step 2: Graph API Collection ---

const fetchGraphApiWithRetry = async (
  url: string,
  showUsageHeader: boolean = false,
  minLimit: number = 10,
): Promise<GraphApiFetchResult | null> => {
  let currentUrl = url;
  let currentLimit = extractLimit(url);

  while (currentLimit >= minLimit) {
    console.log(`Fetching Graph API: ${currentUrl}`);
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
      },
    });

    const data = await response.json();
    if (showUsageHeader) {
      const usageHeader =
        response.headers.get("x-business-use-case-usage") ?? "{}";
      const usage = JSON.parse(usageHeader);
      console.log(`API Usage:`, JSON.stringify(usage, null, 2));
    }

    // Handle Data Limit Error (Code 1)
    if (!data || data.error?.code === 1) {
      console.warn(
        `⚠️ Hit data limit error. Reducing limit from ${currentLimit} to ${Math.floor(currentLimit / 2)}`,
      );
      currentLimit = Math.floor(currentLimit / 2);

      if (currentLimit < minLimit) {
        console.error(
          `✗ Could not process batch even at minimum limit (${minLimit})`,
        );
        return null;
      }

      currentUrl = updateLimit(url, currentLimit);
      continue;
    }

    if (data.error) {
      console.error("API Error:", data.error);
      return null;
    }

    // Validation
    const parseResult = adLibraryResponseSchema.safeParse(data);
    if (!parseResult.success) {
      console.error("Validation error:", parseResult.error);
      return null;
    }

    const ads = parseResult.data.data;
    if (!ads || ads.length === 0) {
      return { ids: [], nextUrl: null };
    }

    const ids = ads.map((ad: any) => ad.id.toString());
    console.log(`✓ Fetched ${ids.length} IDs.`);

    return {
      ids,
      nextUrl: ids.length < currentLimit ? null : data.paging?.next || null,
    };
  }

  return null;
};

const collectAllAdIds = async (pagesPath: string, graphApiPath: string) => {
  const fileContent = await readFile(pagesPath, "utf8");
  const pages: PageState[] = JSON.parse(fileContent);

  for (const page of pages) {
    if (page.status === "processed") {
      continue;
    }

    console.log(`\n=== Processing Page ${page.pageId} ===`);
    page.status = "in_progress";
    await writeFile(pagesPath, JSON.stringify(pages, null, 2));

    while (page.currentUrl) {
      const result = await fetchGraphApiWithRetry(page.currentUrl, true);
      if (!result) {
        console.error(
          `Failed to fetch cursor for page ${page.pageId}. Halting page progress.`,
        );
        break;
      }

      if (result.ids.length > 0) {
        await appendIdsToGraphApiJsonl(graphApiPath, result.ids);
      }

      if (result.nextUrl) {
        page.currentUrl = result.nextUrl;
        await writeFile(pagesPath, JSON.stringify(pages, null, 2));
      } else {
        page.currentUrl = null;
        page.status = "processed";
        await writeFile(pagesPath, JSON.stringify(pages, null, 2));
        console.log(`✓ Page ${page.pageId} exhausted completely.`);
        break;
      }
    }
  }
};

// --- Step 3: Puppeteer Capture ---
const captureGraphQLRequest = async (
  firstAdId: string,
  browser: Browser,
): Promise<CapturedRequest | null> => {
  console.log(
    `\n=== Spinning up new page for template extraction (Ad ID: ${firstAdId}) ===`,
  );
  const snapshotParams = new URLSearchParams({
    id: firstAdId,
    access_token: ACCESS_TOKEN,
  });

  const snapshotUrl = `${SNAPSHOT_BASE_URL}?${snapshotParams.toString()}`;

  const page = await browser.newPage();
  let capturedGraphQLRequest: CapturedRequest | null = null;

  const requestPromise = new Promise<CapturedRequest>((resolve) => {
    page.on("response", async (requestResponse) => {
      const request = requestResponse.request();
      const url = request.url();

      if (url.includes("/graphql")) {
        const headers = request.headers();
        const body = (await request.fetchPostData()) || "";

        const cleanedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          if (!key.startsWith(":")) {
            cleanedHeaders[key] = String(value);
          }
        }

        resolve({ headers: cleanedHeaders, body });
      }
    });
  });

  try {
    await page.goto(snapshotUrl, { waitUntil: "networkidle2", timeout: 30000 });
    capturedGraphQLRequest = await Promise.race([
      requestPromise,
      new Promise<CapturedRequest>((_, reject) =>
        setTimeout(
          () => reject(new Error("GraphQL request not captured in time")),
          15000,
        ),
      ),
    ]);
    console.log(`✓ Intercepted GraphQL successfully.`);
  } catch (err) {
    console.error("Failed to capture GraphQL request:", err);
  } finally {
    await page.close();
  }

  return capturedGraphQLRequest;
};

class TemplateExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateExpiredError";
  }
}

// --- Step 4: Individual Fetching & Processing ---

const individualFetch = async (
  adID: string,
  writeStream: FileHandle,
  capturedGraphQLRequest: CapturedRequest,
) => {
  const newVars = { adID };
  const encodedNewVars = encodeURIComponent(JSON.stringify(newVars));

  const modifiedBody = capturedGraphQLRequest.body.replace(
    /variables=[^&]*/,
    `variables=${encodedNewVars}`,
  );

  const modifiedReferer = capturedGraphQLRequest.headers["referer"]?.replace(
    /id=\d+/,
    `id=${adID}`,
  );

  const modifiedHeaders = {
    ...capturedGraphQLRequest.headers,
    referer: modifiedReferer,
  };

  try {
    const response = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: modifiedHeaders,
      body: modifiedBody,
    });

    if (response.status === 401 || response.status === 403) {
      throw new TemplateExpiredError(`Status ${response.status}`);
    }

    const responseData = await response.json();
    if (!responseData || responseData.errors) {
      throw new TemplateExpiredError(
        `API error: ${responseData?.errors || "Unknown error"}`,
      );
    }

    const data =
      responseData.data?.ad_library_main?.demo_ad_archive_result
        ?.demo_ad_archive;
    if (!data) {
      throw new TemplateExpiredError("Missing expected data in response");
    }

    await writeStream.write(
      JSON.stringify({
        ad_id: adID,
        status: response.status,
        data,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  } catch (err) {
    if (err instanceof TemplateExpiredError) {
      throw err; // bubble up to trigger template refresh
    }
    await writeStream.write(
      JSON.stringify({
        ad_id: adID,
        error: String(err),
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  }
};

const processAdsFromGraphApi = async (
  graphApiPath: string,
  outputPath: string,
  browser: Browser,
  networkSliceSize: number = 20,
) => {
  let allIds: string[] = [];
  try {
    const fileContent = await readFile(graphApiPath, "utf8");
    allIds = fileContent
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).id;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    console.error(
      `Could not read ${graphApiPath}. Have you run the collector step?`,
    );
    return;
  }

  if (allIds.length === 0) {
    console.log("No IDs to process.");
    return;
  }

  const writeStream = await fopen(outputPath, "a");

  console.log(`\n=== Processing ${allIds.length} total ads ===`);

  let currentTemplate: CapturedRequest | null = null;
  let currentIndex = 0;

  while (currentIndex < allIds.length) {
    if (!currentTemplate) {
      currentTemplate = await captureGraphQLRequest(
        allIds[currentIndex],
        browser,
      );
      if (!currentTemplate) {
        console.error(
          `Failed to get GraphQL template for Ad ID ${allIds[currentIndex]}. Skipping one Ad ID.`,
        );
        currentIndex++;
        continue;
      }
    }

    const slice = allIds.slice(currentIndex, currentIndex + networkSliceSize);

    try {
      await Promise.all(
        slice.map((adId) =>
          individualFetch(adId, writeStream, currentTemplate!),
        ),
      );

      currentIndex += slice.length;
      stdout.write(`\rProcessed ${currentIndex}/${allIds.length} ads`);
      await setTimeoutP(1000 + Math.random() * 500);
    } catch (err) {
      if (err instanceof TemplateExpiredError) {
        console.log(
          `\nTemplate expired (${err.message}). refreshing template.`,
        );
        currentTemplate = null; // will be refreshed in next loop iteration
      } else {
        console.error("Unexpected error processing slice:", err);
        // We shouldn't hit this since individualFetch catches non-expired errors, but just in case
        currentIndex += slice.length;
      }
    }
  }

  console.log();
  await writeStream.close();
  console.log(`\n✓ All ads processed and saved to ${outputPath}`);
};

const main = async () => {
  const CSV_FILE = "./page_ids.csv";
  const PAGES_JSON = "./pages.json";
  const GRAPH_API_JSONL = "./graph-api.jsonl";
  const ADS_JSONL = "./ads.jsonl";

  // Step 1: Initialize pages tracking file
  await initializePages(CSV_FILE, PAGES_JSON);

  // Step 2: Traverse Graph API & harvest purely string IDs into graph-api.jsonl
  await collectAllAdIds(PAGES_JSON, GRAPH_API_JSONL);

  // Step 3 & 4: Process the harvested IDs using Puppeteer logic
  const browser = await launch({ headless: true });
  try {
    await processAdsFromGraphApi(GRAPH_API_JSONL, ADS_JSONL, browser);
  } finally {
    await browser.close();
  }
};

if (import.meta.main) {
  await main().catch((error) => {
    console.error("Unexpected error in main execution:", error);
    process.exit(1);
  });
}
