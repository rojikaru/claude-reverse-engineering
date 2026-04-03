import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { adLibraryResponseSchema } from "./validator.js";
import { ACCESS_TOKEN } from "./config.js";
import {
  appendJsonlRecords,
  readJsonArray,
  writeJsonArray,
} from "./storage.js";
import {
  createGraphApiUrl,
  type GraphApiFetchResult,
  type PageState,
} from "./types.js";

const GRAPH_API_MAX_RETRIES = 5;
const GRAPH_API_BASE_RETRY_MS = 1000;
const GRAPH_API_MAX_RETRY_MS = 30000;
const GRAPH_API_MIN_LIMIT = 10;

class RetryableGraphApiError extends Error {
  readonly shouldDecayLimit: boolean;

  constructor(message: string, shouldDecayLimit: boolean = false) {
    super(message);
    this.name = "RetryableGraphApiError";
    this.shouldDecayLimit = shouldDecayLimit;
  }
}

interface GraphApiPayload {
  error?: {
    code?: number;
    message?: string;
  };
}

type GraphApiAttemptResult =
  | {
      type: "success";
      data: GraphApiFetchResult;
    }
  | {
      type: "rate_limited";
    }
  | {
      type: "retry";
      requestUrl: string;
      currentLimit: number;
      reason: string;
    }
  | {
      type: "fatal";
    };

interface FetchGraphApiPageParams {
  url: string;
  currentLimit: number;
  showUsageHeader?: boolean;
}

interface FetchGraphApiPageResult {
  result: GraphApiFetchResult | null;
  currentLimit: number;
  haltRemainingPages: boolean;
}

interface GraphApiAttemptResolution {
  kind: "success" | "fatal" | "rate_limited" | "retry";
  result?: GraphApiFetchResult;
  nextState: FetchGraphApiState;
  reason?: string;
}

interface FetchGraphApiState {
  requestUrl: string;
  currentLimit: number;
}

const getLimitFromUrl = (url: string) => {
  const params = new URL(url).searchParams;
  const limit = Number.parseInt(params.get("limit") ?? "5000", 10);
  return Number.isFinite(limit) ? limit : 5000;
};

const updateLimitInUrl = (url: string, limit: number) => {
  const urlObj = new URL(url);
  urlObj.searchParams.set("limit", String(limit));
  return urlObj.toString();
};

const getRetryDelayMs = (attempt: number) => {
  const exponential = Math.min(
    GRAPH_API_MAX_RETRY_MS,
    GRAPH_API_BASE_RETRY_MS * 2 ** attempt,
  );
  const jitter = Math.floor(Math.random() * 350);
  return exponential + jitter;
};

const resolveGraphApiAttempt = (
  parsed: GraphApiAttemptResult,
  state: FetchGraphApiState,
): GraphApiAttemptResolution => {
  if (parsed.type === "success") {
    return {
      kind: "success",
      result: parsed.data,
      nextState: state,
    };
  }

  if (parsed.type === "rate_limited") {
    return {
      kind: "rate_limited",
      nextState: state,
    };
  }

  if (parsed.type === "fatal") {
    return {
      kind: "fatal",
      nextState: state,
    };
  }

  return {
    kind: "retry",
    nextState: {
      requestUrl: parsed.requestUrl,
      currentLimit: parsed.currentLimit,
    },
    reason: parsed.reason,
  };
};

const handleGraphApiRetryState = (
  error: unknown,
  state: FetchGraphApiState,
): FetchGraphApiState => {
  if (error instanceof RetryableGraphApiError && !error.shouldDecayLimit) {
    return state;
  }

  const nextLimit = Math.max(
    GRAPH_API_MIN_LIMIT,
    Math.floor(state.currentLimit / 2),
  );
  return {
    requestUrl: updateLimitInUrl(state.requestUrl, nextLimit),
    currentLimit: nextLimit,
  };
};

const shouldRetryGraphApiAttempt = async (
  attempt: number,
  error: unknown,
): Promise<boolean> => {
  const retriesLeft = GRAPH_API_MAX_RETRIES - (attempt + 1);
  if (retriesLeft <= 0) {
    console.error(
      `Graph API request failed after ${GRAPH_API_MAX_RETRIES} attempts:`,
      error,
    );
    return false;
  }

  const delayMs = getRetryDelayMs(attempt);
  console.warn(
    `Graph API attempt ${attempt + 1}/${GRAPH_API_MAX_RETRIES} failed. Retrying in ${delayMs}ms...`,
    error,
  );
  await setTimeout(delayMs);
  return true;
};

const parseGraphApiAttempt = (
  rawData: unknown,
  requestUrl: string,
  currentLimit: number,
): GraphApiAttemptResult => {
  if (!rawData) {
    throw new RetryableGraphApiError(
      "Graph API returned an empty response.",
      true,
    );
  }

  const payload = rawData as GraphApiPayload;
  if (payload.error?.code === 613) {
    console.error("API Error:", payload.error);
    return { type: "rate_limited" };
  }

  if (payload.error?.code === 1) {
    const nextLimit = Math.floor(currentLimit / 2);
    if (nextLimit < GRAPH_API_MIN_LIMIT) {
      console.error(
        `API Error: ${JSON.stringify(payload.error)}. Reached minimum limit ${GRAPH_API_MIN_LIMIT}.`,
      );
      return { type: "fatal" };
    }

    return {
      type: "retry",
      requestUrl: updateLimitInUrl(requestUrl, nextLimit),
      currentLimit: nextLimit,
      reason: `Data limit reached. Retrying with reduced limit ${nextLimit}.`,
    };
  }

  if (payload.error) {
    console.error("API Error:", payload.error);
    return { type: "fatal" };
  }

  const parseResult = adLibraryResponseSchema.safeParse(rawData);
  if (!parseResult.success) {
    console.error("Validation error:", parseResult.error);
    return { type: "fatal" };
  }

  const ads = parseResult.data.data;
  if (!ads || ads.length === 0) {
    return {
      type: "success",
      data: { ids: [], nextUrl: parseResult.data.paging?.next || null },
    };
  }

  const ids = ads.map((ad: any) => ad.id.toString());
  console.log(`✓ Fetched ${ids.length} IDs.`);
  return {
    type: "success",
    data: {
      ids,
      nextUrl: parseResult.data.paging?.next || null,
    },
  };
};

const fetchGraphApiPage = async ({
  url,
  currentLimit,
  showUsageHeader = false,
}: FetchGraphApiPageParams): Promise<FetchGraphApiPageResult> => {
  let state: FetchGraphApiState = {
    requestUrl: updateLimitInUrl(url, currentLimit),
    currentLimit,
  };

  for (let attempt = 0; attempt < GRAPH_API_MAX_RETRIES; attempt += 1) {
    try {
      state.requestUrl = updateLimitInUrl(state.requestUrl, state.currentLimit);

      console.log(`Fetching Graph API: ${state.requestUrl}`);

      const response = await fetch(state.requestUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
        },
      });

      const data: unknown = await response.json();
      if (showUsageHeader) {
        const usageHeader =
          response.headers.get("x-business-use-case-usage") ?? "{}";
        const usage = JSON.parse(usageHeader);
        console.log(`API Usage:`, JSON.stringify(usage, null, 2));
      }

      const parsed = parseGraphApiAttempt(
        data,
        state.requestUrl,
        state.currentLimit,
      );
      const resolution = resolveGraphApiAttempt(parsed, state);
      state = resolution.nextState;

      if (resolution.kind === "success") {
        return {
          result: resolution.result ?? null,
          currentLimit: state.currentLimit,
          haltRemainingPages: false,
        };
      }

      if (resolution.kind === "rate_limited") {
        return {
          result: null,
          currentLimit: state.currentLimit,
          haltRemainingPages: true,
        };
      }

      if (resolution.kind === "fatal") {
        return {
          result: null,
          currentLimit: state.currentLimit,
          haltRemainingPages: false,
        };
      }

      throw new RetryableGraphApiError(resolution.reason ?? "Graph API retry");
    } catch (error) {
      state = handleGraphApiRetryState(error, state);
      if (!(await shouldRetryGraphApiAttempt(attempt, error))) {
        return {
          result: null,
          currentLimit: state.currentLimit,
          haltRemainingPages: false,
        };
      }
    }
  }

  return {
    result: null,
    currentLimit: state.currentLimit,
    haltRemainingPages: false,
  };
};

export const initializePageStates = async (
  csvPath: string,
  pageStatesPath: string,
): Promise<PageState[]> => {
  const existingPageStates = await readJsonArray<PageState>(pageStatesPath);
  if (existingPageStates.length > 0) {
    console.log(
      `Loaded ${existingPageStates.length} existing page states from ${pageStatesPath}`,
    );
    return existingPageStates;
  }

  console.log("No existing page states found, creating new ones from CSV.");
  const csvContent = await readFile(csvPath, "utf8");
  const targetAccounts = csvContent
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

  const pageStates: PageState[] = targetAccounts.map((pageId, index) => ({
    id: index + 1,
    pageId,
    currentUrl: createGraphApiUrl(pageId, ACCESS_TOKEN, 4000),
    status: "unprocessed",
  }));

  await writeJsonArray(pageStatesPath, pageStates);
  return pageStates;
};

interface PageProcessingResult {
  fetched: number;
  haltRemainingPages: boolean;
}

const processPageState = async (
  pageState: PageState,
  pageStates: PageState[],
  pageStatesPath: string,
  graphApiPath: string,
): Promise<PageProcessingResult> => {
  if (pageState.status === "processed") {
    return { fetched: 0, haltRemainingPages: false };
  }

  console.log(
    `\n=== Processing Page ${pageState.id} (${pageState.pageId}) ===`,
  );
  pageState.status = "in_progress";
  await writeJsonArray(pageStatesPath, pageStates);

  let pageIdsFetched = 0;
  let pageLimit = pageState.currentUrl
    ? getLimitFromUrl(pageState.currentUrl)
    : 4000;
  while (pageState.currentUrl) {
    // Random delay between 1-3 seconds
    await setTimeout(1000 + Math.random() * 2000);

    const { result, currentLimit, haltRemainingPages } =
      await fetchGraphApiPage({
        url: pageState.currentUrl,
        showUsageHeader: true,
        currentLimit: pageLimit,
      });
    pageLimit = currentLimit;

    if (haltRemainingPages) {
      console.error(
        `Graph API rate limit reached while processing page ${pageState.id}. Skipping all remaining page harvest and moving to GraphQL processing.`,
      );
      pageState.status = "unprocessed";
      pageState.currentUrl = updateLimitInUrl(pageState.currentUrl, pageLimit);
      await writeJsonArray(pageStatesPath, pageStates);
      return { fetched: pageIdsFetched, haltRemainingPages: true };
    }

    if (!result) {
      console.error(
        `Failed to fetch cursor for page ${pageState.id} after retries. Moving to next page and preserving cursor for resume.`,
      );
      pageState.status = "unprocessed";
      pageState.currentUrl = updateLimitInUrl(pageState.currentUrl, pageLimit);
      await writeJsonArray(pageStatesPath, pageStates);
      return { fetched: pageIdsFetched, haltRemainingPages: false };
    }

    if (result.ids.length > 0) {
      await appendJsonlRecords(
        graphApiPath,
        result.ids.map((id) => JSON.stringify(id)),
      );
      pageIdsFetched += result.ids.length;
    }

    pageState.currentUrl = result.nextUrl
      ? updateLimitInUrl(result.nextUrl, pageLimit)
      : null;
    await writeJsonArray(pageStatesPath, pageStates);
  }

  pageState.status = "processed";
  await writeJsonArray(pageStatesPath, pageStates);
  console.log(`✓ Page ${pageState.id} exhausted completely.`);
  console.log(
    `Total ad IDs fetched for page ${pageState.id}: ${pageIdsFetched}`,
  );
  return { fetched: pageIdsFetched, haltRemainingPages: false };
};

export const collectAllAdIds = async (
  pageStatesPath: string,
  graphApiPath: string,
) => {
  const pageStates = await readJsonArray<PageState>(pageStatesPath);
  if (pageStates.length === 0) {
    console.error(
      `Could not read ${pageStatesPath}. Have you run initialization?`,
    );
    return;
  }

  let totalIdsFetched = 0;
  for (const pageState of pageStates) {
    console.log(`Total ad IDs fetched so far: ${totalIdsFetched}\n`);
    const pageResult = await processPageState(
      pageState,
      pageStates,
      pageStatesPath,
      graphApiPath,
    );
    totalIdsFetched += pageResult.fetched;
    if (pageResult.haltRemainingPages) {
      console.log(
        "Graph API collector halted early due to rate limiting. Proceeding to GraphQL processing.",
      );
      break;
    }
  }
  console.log(
    `\n✓ All pages processed. Total ad IDs fetched: ${totalIdsFetched}`,
  );
};
