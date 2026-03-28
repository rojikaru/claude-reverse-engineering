import { type FileHandle, open as fopen } from "node:fs/promises";
import assert from "node:assert";
import { stdout } from "node:process";
import { availableParallelism } from "node:os";
import process from "node:process";

import puppeteer from "puppeteer";
import { adLibraryResponseSchema } from "./validator.js";

const graphApiBaseUrl = "https://graph.facebook.com/v24.0/ads_archive";
const snapshotBaseUrl = "https://www.facebook.com/ads/archive/render_ad";

const access_token = process.env.ACCESS_TOKEN;
assert.ok(access_token, "ACCESS_TOKEN must be set in environment variables");

interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

let capturedGraphQLRequest: CapturedRequest | null = null;

const individualFetch = async (adID: string, writeStream: FileHandle) => {
  if (!capturedGraphQLRequest) {
    console.error("No GraphQL request captured");
    process.exit(1);
  }

  // Swap out ID for current ad
  const newVars = { adID };
  const encodedNewVars = encodeURIComponent(JSON.stringify(newVars));

  // Replace variables in the body
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

    const responseData = await response.json();
    if (!responseData || responseData.errors) {
      throw new Error(
        `API error: ${responseData?.errors || "Unknown error"}`,
      );
    }

    // Write to JSONL
    await writeStream.write(
      JSON.stringify({
        ad_id: adID,
        status: response.status,
        data: responseData,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  } catch (err) {
    console.error(`Error fetching ad ${adID}:`, err);
    await writeStream.write(
      JSON.stringify({
        ad_id: adID,
        error: String(err),
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  }
};

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

const processBatch = async (
  url: string,
  writeStream: FileHandle,
): Promise<string | null> => {
  let currentUrl = url;
  let currentLimit = extractLimit(url);
  const minLimit = 10; // Don't go below 10 items per request
  let lastError: { code: number; message: string } | null = null;

  while (currentLimit >= minLimit) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
      },
    });
    const data = await response.json();

    const usageHeader =
      response.headers.get("x-business-use-case-usage") ?? "{}";
    const usage = JSON.parse(usageHeader);
    console.log(`API Response status: ${response.status}`);
    console.log(`API Usage:`, JSON.stringify(usage, null, 2));

    // Check for the specific error: "Please reduce the amount of data you're asking for"
    if (!data || data.error?.code === 1) {
      console.warn(
        `⚠️  Hit data limit error. Reducing limit from ${currentLimit} to ${Math.floor(currentLimit / 2)}`,
      );
      lastError = data?.error;

      // Halve the limit and retry
      currentLimit = Math.floor(currentLimit / 2);
      if (currentLimit < minLimit) {
        console.error(
          `✗ Could not process batch even at minimum limit (${minLimit})`,
        );
        console.error("API Error:", data?.error);
        process.exit(1);
      }

      // Update URL with new limit
      currentUrl = updateLimit(url, currentLimit);
      continue;
    }

    // Handle other errors
    if (data.error) {
      console.error("API Error:", data?.error || "Unknown error");
      process.exit(1);
    }

    console.log("API Response keys:", Object.keys(data));
    console.log("API Response data type:", typeof data.data);
    if (data.data) {
      console.log(
        "API Response data sample:",
        JSON.stringify(data.data).substring(0, 200),
      );
    }

    const parseResult = adLibraryResponseSchema.safeParse(data);

    if (!parseResult.success) {
      console.error("Validation error:", parseResult.error);
      process.exit(1);
    }

    const ads = parseResult.data.data;

    if (!ads || ads.length === 0) {
      console.warn("No ads found");
      return null;
    }

    console.log(
      `✓ Successfully fetched ${ads.length} ads (with limit: ${currentLimit})`,
    );

    // Step 2: Open first ad in browser and intercept GraphQL request
    const [firstAd] = ads;
    assert.ok(firstAd?.id, "First ad should exist");
    console.log(`\n=== Opening first ad (ID: ${firstAd.id}) ===`);

    const snapshotParams = new URLSearchParams({
      id: firstAd.id.toString(),
      access_token,
    });

    const snapshotUrl = `${snapshotBaseUrl}?${snapshotParams.toString()}`;
    console.log(`Snapshot URL: ${snapshotUrl}`);

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Step 3: Listen for GraphQL requests
    const requestPromise = new Promise<CapturedRequest>((resolve) => {
      page.on("response", async (requestResponse) => {
        const request = requestResponse.request();
        const url = request.url();

        if (url.includes("/graphql")) {
          console.log(`\n=== Intercepted GraphQL request ===`);
          console.log(`URL: ${url}`);

          const headers = request.headers();
          let body = (await request.fetchPostData()) || "";

          // Filter out HTTP/2 pseudo-headers
          const cleanedHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(headers)) {
            if (!key.startsWith(":")) {
              cleanedHeaders[key] = String(value);
            }
          }

          console.log(`Headers:`, JSON.stringify(cleanedHeaders, null, 2));
          console.log(`Body length: ${body.length} characters`);

          // Extract variables from body
          const variablesMatch = /variables=([^&]*)/.exec(body);
          if (variablesMatch?.[1]) {
            try {
              const decodedVars = decodeURIComponent(variablesMatch[1]);
              console.log(`Variables: ${decodedVars}`);
            } catch {
              console.log(`Could not decode variables`);
            }
          }

          capturedGraphQLRequest = { headers: cleanedHeaders, body };
          resolve({ headers: cleanedHeaders, body });
        }
      });
    });

    // Open the page
    await page.goto(snapshotUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for the request with a timeout
    await Promise.race([
      requestPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("GraphQL request not captured")),
          10000,
        ),
      ),
    ]).catch((err) => console.error("Warning:", err.message));

    await browser.close();

    if (!capturedGraphQLRequest) {
      console.error("Failed to capture GraphQL request");
      process.exit(1);
    }

    // Step 4: Process all ads and save to JSONL
    console.log(`\n=== Processing all ads ===`);

    // Extract the variables from the original body
    const adIDMatch = /variables=([^&]*)/.exec(capturedGraphQLRequest.body);
    if (!adIDMatch?.[1]) {
      console.error("Could not extract variables from body");
      process.exit(1);
    }

    const encodedVars = adIDMatch[1];
    let decodedVars: { adID: string };
    try {
      decodedVars = JSON.parse(decodeURIComponent(encodedVars));
    } catch (e) {
      console.error("Could not parse variables:", e);
      process.exit(1);
    }

    console.log(`Original variables:`, decodedVars);

    const sliceSize = availableParallelism();
    for (let i = 0; i < ads.length; i += sliceSize) {
      const slice = ads.slice(i, i + sliceSize);
      await Promise.all(
        slice.map((ad) => individualFetch(ad.id.toString(), writeStream)),
      );
      stdout.write(`\rProcessed ${i}/${ads.length} ads`);
    }
    console.log(`\nAll ads processed`);

    // Successfully processed, return next pagination URL
    return data.paging?.next || null;
  }

  // If we exit the loop without returning, we've hit the minimum limit
  if (lastError) {
    console.error(
      `✗ Failed to process batch even at minimum limit (${minLimit}): ${lastError.message}`,
    );
  }
  return null;
};

const chunkArray = <T>(arr: T[], size: number) => {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
};

if (import.meta.main) {
  const outputFile = "ads.jsonl";
  const writeStream = await fopen(outputFile, "w");

  const csv = "./page_ids.csv";
  const csvContent = await Bun.file(csv).text();
  const targetAccounts = csvContent
    .split("\n")
    .slice(1) // Skip header
    .map((line) => line.trim())
    .filter(Boolean);

  let totalAds = 0;

  // Step 1: Fetch ads from Graph API
  for (const targetAccountsChunk of chunkArray(targetAccounts, 10)) {
    const graphApiParams = new URLSearchParams({
      ad_type: "ALL",
      ad_active_status: "ALL",
      // search_page_ids: "164271473587410",
      search_page_ids: targetAccountsChunk.join(","),
      ad_reached_countries: "['']",
      limit: "2000",
      // fields: "total_reach_by_location,target_locations,currency,ad_creation_time,ad_creative_bodies,impressions,spend,page_id,ad_snapshot_url,ad_delivery_start_time,ad_delivery_stop_time",
      fields: "id",
      access_token,
    });

    let url: string | null | undefined =
      `${graphApiBaseUrl}?${graphApiParams.toString()}`;

    while (url) {
      console.log(`Fetching: ${url}`);
      url = await processBatch(url, writeStream);
    }

    totalAds += targetAccountsChunk.length;
    console.log(`\nTotal accounts processed: ${totalAds}`);
  }

  await writeStream.close();
  console.log(`\nResults saved to ${outputFile}`);
}
