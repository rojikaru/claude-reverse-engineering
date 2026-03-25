// Zod schemas for Facebook Ads Library data.
// See [their docs](https://www.facebook.com/ads/library/api/) for the specific fields.

import { z } from "zod/mini";

// https://developers.facebook.com/docs/graph-api/reference/age-country-gender-reach-breakdown/
export const ageCountryGenderReachBreakdownSchema = z.object({
  age_gender_breakdowns: z.array(
    z.object({
      age_range: z.string(),
      male: z._default(z.coerce.number(), 0),
      female: z._default(z.coerce.number(), 0),
      unknown: z._default(z.coerce.number(), 0),
    }),
  ),
  country: z.string().check(z.minLength(2), z.maxLength(2)),
});
export type AgeCountryGenderReachBreakdownSchema = z.infer<
  typeof ageCountryGenderReachBreakdownSchema
>;

export const reachSchema = z.object({
  key: z.string(),
  value: z._default(z.coerce.number(), 0),
});
export type ReachSchema = z.infer<typeof reachSchema>;

// https://developers.facebook.com/docs/graph-api/reference/insights-range-value/
export const rangeSchema = z.object({
  lower_bound: z.nullish(z.coerce.number()),
  upper_bound: z.nullish(z.coerce.number()),
});
export type RangeSchema = z.infer<typeof rangeSchema>;

// https://developers.facebook.com/docs/graph-api/reference/target-location/
export const targetLocationSchema = z.object({
  excluded: z.boolean(),
  name: z.string(),
  num_obfuscated: z._default(z.coerce.number(), 0),
  type: z.string(),
});
export type TargetLocationSchema = z.infer<typeof targetLocationSchema>;

export const adLibraryBaseSchema = z.object({
  id: z.coerce.bigint(),
  page_id: z.coerce.bigint(),
  page_name: z.nullish(z.string()),
  publisher_platforms: z._default(z.array(z.string()), []),
  ad_creation_time: z.nullish(z.coerce.date()),
  ad_delivery_start_time: z.coerce.date(),
  ad_delivery_stop_time: z.nullish(z.coerce.date()),
  ad_snapshot_url: z.httpUrl(),
  languages: z._default(z.array(z.string()), []),

  // EU/UK only
  target_ages: z.nullish(z.array(z.coerce.number())),
  target_gender: z._default(z.string(), "ALL"),
  target_locations: z.nullish(z.array(targetLocationSchema)),
});

export const adLibraryObservationSchema = z.object({
  id: z.coerce.bigint(),

  // EU/UK only
  age_country_gender_reach_breakdown: z.nullish(
    z.array(ageCountryGenderReachBreakdownSchema),
  ),
  total_reach_by_location: z.nullish(z.array(reachSchema)),

  // Political ads only
  estimated_audience_size: z.nullish(rangeSchema),
  impressions: z.nullish(rangeSchema),
  currency: z.nullish(z.string()),
  spend: z.nullish(rangeSchema),
});

// See [Facebook docs](https://www.facebook.com/ads/library/api/) for specific fields / version updates.
export const adLibrarySchema = z.object({
  ...adLibraryBaseSchema.shape,
  ...adLibraryObservationSchema.shape,
});
export type AdLibrarySchema = z.infer<typeof adLibrarySchema>;

export const graphApiPagingSchema = z.object({
  cursors: z.object({
    before: z.nullish(z.string()),
    after: z.nullish(z.string()),
  }),
  next: z.nullish(z.string()),
});

export const graphApiErrorSchema = z.object({
  message: z._default(
    z.string(),
    "Unknown Facebook Graph API response validation error",
  ),
  type: z.nullish(z.string()),
  code: z.nullish(z.number()),
  fbtrace_id: z.nullish(z.string()),
});
export type GraphApiErrorSchema = z.infer<typeof graphApiErrorSchema>;

export const adLibraryResponseSchema = z.object({
  data: z._default(z.array(z.partial(adLibrarySchema)), []),
  paging: z.nullish(graphApiPagingSchema),
  error: z.nullish(graphApiErrorSchema),
});
