import { type FileHandle, open as fopen } from "node:fs/promises";
import { stdout } from "node:process";
import { setTimeout as setTimeoutP } from "node:timers/promises";

import pLimit from "p-limit";
import { Agent, fetch as undiciFetch } from "undici";

import { GRAPHQL_ENDPOINT } from "./config.js";
import { GraphQLTemplateSession } from "./browser.js";
import { readJsonlRecords } from "./storage.js";
import type { CapturedRequest } from "./types.js";

const keepAliveAgent = new Agent({
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000,
  connections: 200,
});

class SessionRefreshRequiredError extends Error {}

interface GraphQlResponsePayload {
  errors?: unknown;
  data?: {
    ad_library_main?: {
      demo_ad_archive_result?: {
        demo_ad_archive?: unknown;
      };
    };
  };
}

const buildModifiedRequest = (
  adID: string,
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

  const modifiedHeaders: Record<string, string> = {
    ...capturedGraphQLRequest.headers,
  };

  if (modifiedReferer) {
    modifiedHeaders.referer = modifiedReferer;
  }

  return { modifiedBody, modifiedHeaders };
};

const isSessionExpiryResponse = (responseData: unknown): boolean => {
  if (!responseData || typeof responseData !== "object") {
    return false;
  }

  const typedResponse = responseData as {
    errors?: Array<{ message?: string; code?: number }>;
  };

  return Boolean(
    typedResponse.errors?.some((error) => {
      const message = error.message?.toLowerCase() ?? "";
      return (
        error.code === 401 ||
        message.includes("session") ||
        message.includes("login")
      );
    }),
  );
};

const writeResult = async (
  writeStream: FileHandle,
  payload: Record<string, unknown>,
) => {
  await writeStream.write(`${JSON.stringify(payload)}\n`);
};

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
};

const fetchAdData = async (
  adID: string,
  writeStream: FileHandle,
  capturedGraphQLRequest: CapturedRequest,
) => {
  const { modifiedBody, modifiedHeaders } = buildModifiedRequest(
    adID,
    capturedGraphQLRequest,
  );

  const response = await undiciFetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: modifiedHeaders,
    body: modifiedBody,
    dispatcher: keepAliveAgent,
  });

  if (response.status === 401) {
    throw new SessionRefreshRequiredError(
      `GraphQL request returned ${response.status}`,
    );
  }

  const responseData: unknown = await response.json();
  if (isSessionExpiryResponse(responseData)) {
    throw new SessionRefreshRequiredError("GraphQL session expired");
  }

  const payload = responseData as GraphQlResponsePayload;
  if (!payload || payload.errors) {
    const errors = payload?.errors as any[];
    if (
      errors?.some?.(
        (e: any) =>
          e.code === 1675004 || e.message?.includes("Rate limit exceeded"),
      )
    ) {
      console.error(
        `Rate limit exceeded (1675004). Exiting. Errors: ${JSON.stringify(errors)}`,
      );
      process.exit(1);
    }
    throw new Error(
      `API error: ${JSON.stringify(payload?.errors) || "Unknown error"}`,
    );
  }

  const data =
    payload.data?.ad_library_main?.demo_ad_archive_result?.demo_ad_archive;
  if (!data) {
    console.error("Missing expected data in response");
    process.exit(1);
  }

  await writeResult(writeStream, {
    ad_id: adID,
    status: response.status,
    data,
    timestamp: new Date().toISOString(),
  });
};

const processSingleAd = async (
  adID: string,
  writeStream: FileHandle,
  templateSession: GraphQLTemplateSession,
) => {
  const logError = async (error: unknown) => {
    await writeResult(writeStream, {
      ad_id: adID,
      error: formatError(error),
      timestamp: new Date().toISOString(),
    });
  };

  const runOnce = async () => {
    const capturedGraphQLRequest = await templateSession.getTemplate(adID);
    if (!capturedGraphQLRequest) {
      throw new Error("Missing GraphQL template");
    }

    await fetchAdData(adID, writeStream, capturedGraphQLRequest);
  };

  try {
    await runOnce();
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      const refreshedTemplate = await templateSession.refresh(adID);
      if (!refreshedTemplate) {
        await logError(error);
        return;
      }

      try {
        await fetchAdData(adID, writeStream, refreshedTemplate);
        return;
      } catch (retryError) {
        await logError(retryError);
        return;
      }
    }

    await logError(error);
  }
};

export const processAdsFromGraphApi = async (
  graphApiPath: string,
  outputPath: string,
  concurrency: number = 20,
) => {
  const allIds = await readJsonlRecords<string>(graphApiPath);
  if (allIds.length === 0) {
    console.log("No IDs to process.");
    return;
  }

  const writeStream = await fopen(outputPath, "a");
  const templateSession = new GraphQLTemplateSession();
  const limit = pLimit(concurrency);
  const inFlight = new Set<Promise<void>>();

  try {
    const firstId = allIds.at(0);
    if (!firstId) {
      console.log("No IDs to process.");
      return;
    }

    const firstTemplate = await templateSession.getTemplate(firstId);
    if (!firstTemplate) {
      console.error(
        "Skipping processing because no GraphQL template could be captured.",
      );
      return;
    }

    console.log(
      `\n=== Processing ${allIds.length} total ads with concurrency ${concurrency} ===`,
    );

    let deletedCount = 0;
    for (const adId of allIds) {
      let task: Promise<void>;
      task = limit(async () => {
        await processSingleAd(adId, writeStream, templateSession);
        await setTimeoutP(1000 + Math.random() * 1000);
      }).finally(() => {
        inFlight.delete(task);
        deletedCount++;

        const { promise, resolve, reject } = Promise.withResolvers();
        stdout.write(
          `\rProcessed ${deletedCount}/${allIds.length} ads`,
          (err) => (err ? reject(err) : resolve()),
        );
        return promise;
      });

      inFlight.add(task);

      if (inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }
    }

    if (inFlight.size > 0) {
      await Promise.all(inFlight);
    }

    console.log(`\n✓ All ads processed and saved to ${outputPath}`);
  } finally {
    await templateSession.close();
    await writeStream.close();
    await keepAliveAgent.close();
  }
};
