import puppeteer from "puppeteer";
import { setTimeout as sleep } from "node:timers/promises";

import { ACCESS_TOKEN, SNAPSHOT_BASE_URL } from "./config.js";
import type { CapturedRequest } from "./types.js";

const SNAPSHOT_MAX_RETRIES = 4;
const SNAPSHOT_BASE_RETRY_MS = 1000;
const SNAPSHOT_MAX_RETRY_MS = 15000;

const getRetryDelayMs = (attempt: number) => {
  const exponential = Math.min(
    SNAPSHOT_MAX_RETRY_MS,
    SNAPSHOT_BASE_RETRY_MS * 2 ** attempt,
  );
  const jitter = Math.floor(Math.random() * 300);
  return exponential + jitter;
};

export class GraphQLTemplateSession {
  private browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  private cachedRequest: CapturedRequest | null = null;
  private refreshInFlight: Promise<CapturedRequest | null> | null = null;

  async getTemplate(firstAdId: string): Promise<CapturedRequest | null> {
    if (this.cachedRequest) {
      return this.cachedRequest;
    }

    return this.refresh(firstAdId);
  }

  async refresh(firstAdId: string): Promise<CapturedRequest | null> {
    if (this.refreshInFlight !== null) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.capture(firstAdId).finally(() => {
      this.refreshInFlight = null;
    });

    const request = await this.refreshInFlight;
    this.cachedRequest = request;
    return request;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.cachedRequest = null;
  }

  private async ensureBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({ headless: true });
    }

    return this.browser;
  }

  private async capture(firstAdId: string): Promise<CapturedRequest | null> {
    console.log(
      `\n=== Spinning up Puppeteer for template extraction (Ad ID: ${firstAdId}) ===`,
    );

    const snapshotParams = new URLSearchParams({
      id: firstAdId,
      access_token: ACCESS_TOKEN,
    });
    const snapshotUrl = `${SNAPSHOT_BASE_URL}?${snapshotParams.toString()}`;

    for (let attempt = 0; attempt < SNAPSHOT_MAX_RETRIES; attempt += 1) {
      const browser = await this.ensureBrowser();
      const page = await browser.newPage();

      try {
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

        await page.goto(snapshotUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        const capturedGraphQLRequest = await Promise.race([
          requestPromise,
          new Promise<CapturedRequest>((_, reject) =>
            setTimeout(
              () => reject(new Error("GraphQL request not captured in time")),
              15000,
            ),
          ),
        ]);

        console.log(`✓ Intercepted GraphQL successfully.`);
        return capturedGraphQLRequest;
      } catch (error) {
        const retriesLeft = SNAPSHOT_MAX_RETRIES - (attempt + 1);
        if (retriesLeft <= 0) {
          console.error(
            `Failed to capture GraphQL request after ${SNAPSHOT_MAX_RETRIES} attempts:`,
            error,
          );
          return null;
        }

        const delayMs = getRetryDelayMs(attempt);
        console.warn(
          `Snapshot capture attempt ${attempt + 1}/${SNAPSHOT_MAX_RETRIES} failed. Retrying in ${delayMs}ms...`,
          error,
        );
        await sleep(delayMs);
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    return null;
  }
}
