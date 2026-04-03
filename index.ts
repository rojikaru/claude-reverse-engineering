import { initializePageStates, collectAllAdIds } from "./graph-api.js";
import { processAdsFromGraphApi } from "./graphql.js";

const main = async () => {
  const CSV_FILE = "./page_ids.csv";
  const PAGE_STATES_JSON = "./page_states.json";
  const GRAPH_API_JSONL = "./graph-api.jsonl";
  const ADS_JSONL = "./ads.jsonl";

  await initializePageStates(CSV_FILE, PAGE_STATES_JSON);
  await collectAllAdIds(PAGE_STATES_JSON, GRAPH_API_JSONL);
  await processAdsFromGraphApi(GRAPH_API_JSONL, ADS_JSONL);
};

if (import.meta.main) {
  await main().catch((error) => {
    console.error("Unexpected error in main execution:", error);
    process.exit(1);
  });
}
