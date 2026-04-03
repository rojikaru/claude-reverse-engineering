export interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

export type PageStatus = "unprocessed" | "in_progress" | "processed";

export interface PageState {
  id: number;
  pageId: string;
  currentUrl: string | null;
  status: PageStatus;
}

export interface GraphApiFetchResult {
  ids: string[];
  nextUrl: string | null;
}

export const createGraphApiUrl = (pageId: string, accessToken: string, limit: number) => {
  const params = new URLSearchParams({
    ad_type: "ALL",
    ad_active_status: "ALL",
    search_page_ids: pageId,
    ad_reached_countries: "['']",
    limit: limit.toString(),
    fields: "id",
    access_token: accessToken,
  });

  return `https://graph.facebook.com/v24.0/ads_archive?${params.toString()}`;
};
