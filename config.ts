import assert from "node:assert";

export const GRAPH_API_BASE_URL =
  "https://graph.facebook.com/v24.0/ads_archive";
export const SNAPSHOT_BASE_URL =
  "https://www.facebook.com/ads/archive/render_ad";
export const GRAPHQL_ENDPOINT = "https://www.facebook.com/api/graphql/";

const requireEnvVar = (varName: string): string => {
  const value = process.env[varName];
  assert.ok(value, `${varName} must be set in environment variables`);
  return value;
};

export const ACCESS_TOKEN = requireEnvVar("ACCESS_TOKEN");
