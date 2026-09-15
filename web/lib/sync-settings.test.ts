import { describe, it, expect } from "vitest";
import { loadSyncSettings, loadCustomMappings, DEFAULT_SYNC_SETTINGS } from "./sync-settings";
import type { Sql } from "./pending-store";

/**
 * These settings were written by the Settings page and read by nothing else, so
 * merge mode, the watch strategy, the activity-type list and HR fusion changed
 * a stored value and nothing about a sync (#565). This module is what carries
 * them, so what matters here is that the stored shape is read faithfully and
 * that a database with nothing in it still syncs sensibly.
 */

/** A fake `sql` tag answering app_cache and custom_mappings reads. */
function fakeSql(config: Record<string, unknown> = {}, mappings: unknown[] = []): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    let rows: unknown[] = [];
    if (text.includes("custom_mappings")) {
      rows = mappings;
    } else if (text.includes("app_cache")) {
      const key = String(values[0] ?? "");
      if (key in config) rows = [{ value: config[key] }];
    }
    const p = Promise.resolve(rows);
    return Object.assign(p, { catch: p.catch.bind(p) });
  }) as unknown as Sql;
  return tag;
}

/** A connection that fails every query, as an empty or older database does. */
function brokenSql(): Sql {
  return (() => {
    const p = Promise.reject(new Error('relation "app_cache" does not exist'));
    return Object.assign(p, { catch: p.catch.bind(p) });
  }) as unknown as Sql;
}

describe("loadSyncSettings", () => {
  it("reads the shape the Settings page saves", async () => {
    const s = await loadSyncSettings(
      fakeSql({
        merge_settings: {
          merge_mode: true,
          merge_watch_strategy: "replace",
          merge_activity_types: ["strength_training", "indoor_cardio"],
          merge_overlap_pct: 85,
          merge_max_drift_min: 12,
          description_enabled: false,
        },
        hr_fusion: { enabled: false },
      }),
    );
    expect(s.merge.enabled).toBe(true);
    expect(s.merge.watchStrategy).toBe("replace");
    expect(s.merge.activityTypes).toEqual(["strength_training", "indoor_cardio"]);
    expect(s.merge.maxDriftMinutes).toBe(12);
    expect(s.hrFusion).toBe(false);
    expect(s.descriptionEnabled).toBe(false);
  });

  it("turns the stored percentage into the fraction the matcher compares against", async () => {
    // 85 in the form, 0.85 in the engine. Passing 85 through would reject every
    // candidate, because no overlap is ever 8500%.
    const s = await loadSyncSettings(fakeSql({ merge_settings: { merge_overlap_pct: 85 } }));
    expect(s.merge.overlapThreshold).toBe(0.85);
  });

  it("falls back to the documented defaults for an empty database", async () => {
    const s = await loadSyncSettings(fakeSql());
    expect(s).toMatchObject({
      merge: {
        enabled: true,
        watchStrategy: "merge",
        activityTypes: ["strength_training"],
        overlapThreshold: 0.7,
        maxDriftMinutes: 20,
      },
      hrFusion: true,
      descriptionEnabled: true,
    });
    expect(s.merge.enabled).toBe(DEFAULT_SYNC_SETTINGS.merge.enabled);
  });

  it("still returns defaults when the queries fail, rather than turning merge off", async () => {
    // A fresh fork's database has no app_cache yet. Reading that as "merge off"
    // would quietly give a new user the behaviour this whole track fixed.
    const s = await loadSyncSettings(brokenSql());
    expect(s.merge.enabled).toBe(true);
    expect(s.hrFusion).toBe(true);
  });

  it("respects merge_mode false, which is a user saying no", async () => {
    const s = await loadSyncSettings(fakeSql({ merge_settings: { merge_mode: false } }));
    expect(s.merge.enabled).toBe(false);
  });

  it("ignores a watch strategy it does not recognise", async () => {
    const s = await loadSyncSettings(fakeSql({ merge_settings: { merge_watch_strategy: "sideways" } }));
    expect(s.merge.watchStrategy).toBe("merge");
  });

  it("ignores an empty activity-type list, which would match nothing", async () => {
    const s = await loadSyncSettings(fakeSql({ merge_settings: { merge_activity_types: [] } }));
    expect(s.merge.activityTypes).toEqual(["strength_training"]);
  });

  it("carries the user's own exercise mappings, so their sets are not dropped", async () => {
    const s = await loadSyncSettings(
      fakeSql({}, [{ hevy_name: "Sissy Squat", category: 25, subcategory: 7 }]),
    );
    expect(s.merge.customMappings).toEqual({ "Sissy Squat": [25, 7] });
  });

  it("leaves the mappings undefined when there are none, so the engine uses its table", async () => {
    const s = await loadSyncSettings(fakeSql());
    expect(s.merge.customMappings).toBeUndefined();
  });
});

describe("loadCustomMappings", () => {
  it("defaults a missing subcategory to zero", async () => {
    const m = await loadCustomMappings(fakeSql({}, [{ hevy_name: "X", category: 3 }]));
    expect(m).toEqual({ X: [3, 0] });
  });

  it("returns nothing when the table is missing", async () => {
    expect(await loadCustomMappings(brokenSql())).toEqual({});
  });
});
