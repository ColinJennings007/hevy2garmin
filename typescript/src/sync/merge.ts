/**
 * Merge a Hevy workout into the Garmin activity the user's watch recorded.
 *
 * This is the piece the web engine never had. It renamed the activity and wrote
 * a description, so every watch strategy behaved like `describe`, and the Merge
 * setting in Settings was wired to nothing. Two users reported that as a broken
 * tool (#495, #565), which it was.
 *
 * Ported from `attempt_merge` in `src/hevy2garmin/merge.py`. The three
 * strategies are unchanged:
 *
 *   describe  keep the watch activity, only write its description. No sets.
 *   merge     push the sets INTO the watch activity and keep it, so the watch's
 *             own metrics (HR, training effect, body battery) survive. Garmin
 *             will not display exercise NAMES on a device-recorded activity, so
 *             they read as "Unknown" while the reps and weights do land (#325).
 *   replace   upload a named activity and delete the watch copy. Real names, at
 *             the cost of the watch-only metrics.
 */
import { findMergeMatch, mergeSearchRange, type CandidateActivity, type MergeMatchOptions } from "../merge-match";
import { buildExerciseSetsPayload, pushWithNameFallback } from "../exercise-sets";
import type { GarminGateway } from "./gateway";

export type WatchStrategy = "merge" | "replace" | "describe";

export const DEFAULT_WATCH_STRATEGY: WatchStrategy = "merge";

/** Strategies that keep the watch's own activity rather than replacing it. */
const IN_PLACE: ReadonlySet<string> = new Set(["merge", "describe"]);

export function isWatchStrategy(v: unknown): v is WatchStrategy {
  return v === "merge" || v === "replace" || v === "describe";
}

/** Garmin marks our own uploads DEVELOPMENT; anything else came from a device. */
export function isWatchRecorded(activity: Pick<CandidateActivity, "manufacturer">): boolean {
  const m = String(activity.manufacturer ?? "").toUpperCase();
  return m !== "" && m !== "DEVELOPMENT";
}

export interface MergeOptions extends MergeMatchOptions {
  strategy?: WatchStrategy;
  /** User overrides for exercises the built-in table does not cover. */
  customMappings?: Record<string, [number, number]>;
}

export interface MergeOutcome {
  /** Did we act on a watch activity at all? */
  merged: boolean;
  activityId?: number;
  strategy?: WatchStrategy;
  /** Set when merged is false, so the caller can log why it fell through. */
  reason?: string;
  /** True when the caller should upload its own activity and delete this one. */
  replaceWatchActivity?: boolean;
  /** How many ACTIVE sets were pushed, for the sync log and for tests. */
  setsPushed?: number;
}

/**
 * Try to fold a Hevy workout into a matching watch activity.
 *
 * Returns `merged: false` with a reason whenever there is nothing to do, so the
 * caller falls back to its normal upload. It never throws for "no match": that
 * is the common case, not an error.
 *
 * For `replace` it does NOT upload or delete anything itself. It reports the
 * matched activity and sets `replaceWatchActivity`, leaving both writes to the
 * caller, which already owns uploading and is the only place that knows whether
 * this is a dry run.
 */
export async function mergeIntoWatchActivity(
  gateway: GarminGateway,
  workout: { start_time?: string; startTime?: string; end_time?: string; endTime?: string; exercises?: unknown[] },
  options: MergeOptions = {},
): Promise<MergeOutcome> {
  const strategy = options.strategy ?? DEFAULT_WATCH_STRATEGY;

  const range = mergeSearchRange(workout);
  if (!range) return { merged: false, reason: "workout has no usable start or end time" };

  let candidates: CandidateActivity[];
  try {
    candidates = await gateway.activitiesByDate(range.start, range.end);
  } catch (e) {
    // A failed lookup is not "no match": say so, so the caller does not record
    // a clean fall-through for what was actually a Garmin outage.
    return { merged: false, reason: `could not list Garmin activities: ${(e as Error).message}` };
  }

  const match = findMergeMatch(workout, candidates ?? [], options);
  if (!match) return { merged: false, reason: "no matching Garmin activity found" };

  const act = match.activity;
  if (!isWatchRecorded(act)) {
    return { merged: false, reason: "matched activity is our own upload, not a watch recording" };
  }
  if (!IN_PLACE.has(strategy)) {
    return { merged: false, activityId: act.activityId, strategy, replaceWatchActivity: true };
  }
  if (strategy === "describe") {
    // Nothing to push. The caller writes the description, as it already does.
    return { merged: true, activityId: act.activityId, strategy, setsPushed: 0 };
  }

  const startTime = act.startTimeGMT || act.startTimeLocal || "";
  const durationS = act.duration ?? 0;
  if (!startTime || durationS <= 0) {
    return { merged: false, reason: "matched activity is missing a start time or duration" };
  }

  const payload = buildExerciseSetsPayload(
    workout as { exercises?: never[] },
    act.activityId,
    startTime,
    durationS,
    options.customMappings,
  );
  if (!payload.exerciseSets.length) {
    return { merged: false, activityId: act.activityId, strategy, reason: "workout has no sets to push" };
  }

  // Back up first. A merge replaces ALL sets on the activity, so without this a
  // failed push leaves the user with neither their watch's sets nor ours.
  let backup: Record<string, unknown> | null = null;
  try {
    backup = await gateway.exerciseSets(act.activityId);
  } catch {
    backup = null; // best effort; the merge does not depend on it
  }

  try {
    await pushWithNameFallback((p) => gateway.putExerciseSets(act.activityId, p), payload);
  } catch (e) {
    if (backup && Array.isArray((backup as { exerciseSets?: unknown }).exerciseSets)) {
      try {
        await gateway.putExerciseSets(act.activityId, backup);
      } catch {
        // Restoring is best effort too; the original error is the one to report.
      }
    }
    return {
      merged: false,
      activityId: act.activityId,
      strategy,
      reason: `exerciseSets push failed: ${(e as Error).message}`,
    };
  }

  return {
    merged: true,
    activityId: act.activityId,
    strategy,
    setsPushed: payload.exerciseSets.filter((s) => s.setType === "ACTIVE").length,
  };
}
