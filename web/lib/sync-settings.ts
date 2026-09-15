/**
 * The user's sync settings, read from where the Settings page saves them.
 *
 * `POST /api/settings` writes `merge_settings` and `hr_fusion` into `app_cache`
 * and the Settings page reads them back to draw the form. Until now nothing
 * else read them, so merge mode, the watch strategy, the activity-type list and
 * HR fusion were controls that changed the stored value and nothing else. This
 * module is what carries them to the sync engine.
 *
 * Key names and defaults match `config.py`, so a database shared with the
 * Python pipeline means the same thing to both.
 */
import type { MergeSettings } from "hevy2garmin";
import type { Sql } from "./pending-store";

export interface SyncSettings {
  merge: MergeSettings;
  hrFusion: boolean;
  descriptionEnabled: boolean;
}

/** What a fresh install syncs with: merge on, sets pushed into the watch activity. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  merge: {
    enabled: true,
    watchStrategy: "merge",
    activityTypes: ["strength_training"],
    overlapThreshold: 0.7,
    maxDriftMinutes: 20,
  },
  hrFusion: true,
  descriptionEnabled: true,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One `app_cache` value, or null. Never throws: a missing table is not fatal. */
async function readConfig(sql: Sql, key: string): Promise<Record<string, unknown> | null> {
  const rows = (await sql`SELECT value FROM app_cache WHERE key = ${key} LIMIT 1`.catch(
    () => [] as Array<{ value: unknown }>,
  )) as Array<{ value: unknown }>;
  const value = rows[0]?.value;
  return isObj(value) ? value : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The exercises the user mapped by hand.
 *
 * Merging pushes structured sets, and a set whose exercise the built-in table
 * does not cover would be dropped without these.
 */
export async function loadCustomMappings(sql: Sql): Promise<Record<string, [number, number]>> {
  const rows = (await sql`
    SELECT hevy_name, category, subcategory FROM custom_mappings
  `.catch(() => [] as Array<{ hevy_name: string; category: number; subcategory: number }>)) as Array<{
    hevy_name: string;
    category: number;
    subcategory: number;
  }>;
  const out: Record<string, [number, number]> = {};
  for (const r of rows) {
    if (!r?.hevy_name) continue;
    out[r.hevy_name] = [Number(r.category), Number(r.subcategory ?? 0)];
  }
  return out;
}

/**
 * The settings a sync should run with.
 *
 * Every field falls back to the documented default, so a database with no
 * `app_cache` rows yet syncs the way a fresh install is meant to rather than
 * with merge silently off.
 */
export async function loadSyncSettings(sql: Sql): Promise<SyncSettings> {
  const [mergeCfg, hrCfg, customMappings] = await Promise.all([
    readConfig(sql, "merge_settings"),
    readConfig(sql, "hr_fusion"),
    loadCustomMappings(sql),
  ]);

  const d = DEFAULT_SYNC_SETTINGS;
  const strategy = String(mergeCfg?.merge_watch_strategy ?? d.merge.watchStrategy);
  const types = Array.isArray(mergeCfg?.merge_activity_types)
    ? (mergeCfg!.merge_activity_types as unknown[]).map(String).filter(Boolean)
    : d.merge.activityTypes!;

  return {
    merge: {
      enabled: bool(mergeCfg?.merge_mode, d.merge.enabled!),
      watchStrategy:
        strategy === "merge" || strategy === "replace" || strategy === "describe"
          ? strategy
          : d.merge.watchStrategy,
      activityTypes: types.length ? types : d.merge.activityTypes,
      // Stored as a percentage for the form, used as a fraction by the matcher.
      overlapThreshold: num(mergeCfg?.merge_overlap_pct, 70) / 100,
      maxDriftMinutes: num(mergeCfg?.merge_max_drift_min, d.merge.maxDriftMinutes!),
      customMappings: Object.keys(customMappings).length ? customMappings : undefined,
    },
    hrFusion: bool(hrCfg?.enabled, d.hrFusion),
    descriptionEnabled: bool(mergeCfg?.description_enabled, d.descriptionEnabled),
  };
}
