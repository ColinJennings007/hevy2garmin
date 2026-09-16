/**
 * Sync a Hevy routine to Garmin as a planned workout, and schedule it on a date.
 * Ports the Garmin side of the Python routine sync:
 *   - create_workout:  POST /workout-service/workout
 *   - schedule_workout: POST /workout-service/schedule/{workoutId}
 * Both are POSTs, so they use the GarminClient's `post`. Unschedule/delete are
 * DELETE requests, which garmin-auth's client does not expose yet — those are
 * left for a package update.
 *
 * Injectable Garmin client factory for tests. The reverse-engineered Garmin
 * planned-workout payload is validated only against a real export (see
 * garmin-workout); a live smoke-test confirms Garmin accepts it.
 */
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { garminDelete } from "./garmin-delete";
import { routineToGarminWorkout, type HevyRoutine, type WorkoutBuildOptions } from "./garmin-workout";
import {
  deleteGarminWorkout,
  listGarminWorkouts,
  staleWorkoutIds,
  workoutContentHash,
  type GarminLibraryWorkout,
} from "./garmin-workout-library";
import { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

interface Opts extends WorkoutBuildOptions {
  garminClientFactory?: () => Promise<GarminClient>;
  /** Re-create even when the content hash says nothing changed. */
  force?: boolean;
}

export interface RoutineSyncResult {
  /** `skipped` means the routine was already on Garmin and unchanged (#603). */
  status: "synced" | "skipped" | "error";
  garminWorkoutId: number | string | null;
  error: string | null;
}

/** Create a Garmin planned workout from a Hevy routine and record it. */
export async function syncRoutine(
  routine: HevyRoutine,
  sql: Sql = getDb(),
  opts: Opts = {},
): Promise<RoutineSyncResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const payload = routineToGarminWorkout(routine, opts);
    const hevyId = String(routine.id);
    const workoutName = String((payload as { workoutName?: unknown }).workoutName ?? "");
    const contentHash = workoutContentHash(payload);

    const rows = (await sql`
      SELECT garmin_workout_id, status, content_hash FROM synced_routines
      WHERE hevy_routine_id = ${hevyId} LIMIT 1
    `.catch(() => [])) as Array<{
      garmin_workout_id: string | null;
      status: string | null;
      content_hash: string | null;
    }>;
    const existing = rows[0] ?? null;

    // Nothing has changed, so there is nothing to do. Recreating an identical
    // workout spends rate-limited Garmin calls to end up where we already were,
    // and before the delete below existed it also left a second copy behind.
    //
    // The hash covers the GENERATED payload, so a change to the builder
    // re-syncs everything on its own rather than needing a manual force
    // (`sync.py:1036-1046`).
    //
    // `schedule_pending` is deliberately not skippable: that row is unfinished,
    // and skipping it would strand the schedule retry.
    const status = existing?.status ?? "success";
    if (!opts.force && existing?.content_hash === contentHash && status === "success") {
      return { status: "skipped", garminWorkoutId: existing.garmin_workout_id, error: null };
    }

    // Ask Garmin what it actually has, so orphans from earlier syncs, a crash,
    // or a database reset are cleaned up rather than accumulating. A listing
    // that fails is "unknown", not "empty": we fall back to the tracked id
    // alone rather than assuming the library is bare.
    let library: GarminLibraryWorkout[] = [];
    try {
      library = await listGarminWorkouts(client);
    } catch {
      library = [];
    }

    // Delete BEFORE creating. The other order means a crash in between leaves
    // the user with two workouts, which is the bug being fixed; this order
    // leaves them with none, and the next sync puts it back.
    for (const staleId of staleWorkoutIds(library, workoutName, existing?.garmin_workout_id ?? null, existing?.status ?? null)) {
      try {
        await deleteGarminWorkout(client, staleId);
      } catch {
        // A stale copy we could not remove is untidy; failing the sync over it
        // would leave the user with no current workout at all.
      }
    }

    const res = await client.post<{ workoutId?: number }>("/workout-service/workout", payload);
    const garminWorkoutId = res?.workoutId ?? null;
    await sql`
      INSERT INTO synced_routines (hevy_routine_id, garmin_workout_id, title, status, content_hash, synced_at)
      VALUES (
        ${hevyId},
        ${garminWorkoutId != null ? String(garminWorkoutId) : null},
        ${routine.title ?? routine.name ?? ""},
        'success', ${contentHash}, NOW()
      )
      ON CONFLICT (hevy_routine_id) DO UPDATE SET
        garmin_workout_id = EXCLUDED.garmin_workout_id,
        title = EXCLUDED.title,
        status = 'success',
        content_hash = EXCLUDED.content_hash,
        synced_at = NOW()
    `;
    return { status: "synced", garminWorkoutId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", garminWorkoutId: null, error };
  }
}

/**
 * Flag synced routines whose Garmin planned workout no longer exists.
 *
 * `workouts` is a full listing; `null` means the listing FAILED. On null this
 * does nothing at all, because treating an error as "the user deleted
 * everything" would flip every routine on the dashboard to missing at once,
 * which is a far worse bug than the one it fixes (`reconcile.py:77-114`).
 *
 * An id that reappears flips back to success, which self-heals a false positive
 * from a truncated listing. `schedule_pending` rows are never promoted, because
 * that would cancel their schedule retry.
 *
 * Returns the routine ids whose status changed.
 */
export async function reconcileMissingRoutineWorkouts(
  sql: Sql,
  workouts: GarminLibraryWorkout[] | null,
): Promise<string[]> {
  if (workouts === null) return [];
  const present = new Set(workouts.map((w) => String(w.id)));
  const changed: string[] = [];
  try {
    const rows = (await sql`
      SELECT hevy_routine_id, garmin_workout_id, status FROM synced_routines
      WHERE garmin_workout_id IS NOT NULL
    `) as Array<{ hevy_routine_id: string; garmin_workout_id: string; status: string | null }>;

    for (const row of rows) {
      const status = row.status ?? "success";
      const isPresent = present.has(String(row.garmin_workout_id));
      if (!isPresent && status !== "missing_on_garmin") {
        await sql`
          UPDATE synced_routines SET status = 'missing_on_garmin'
          WHERE hevy_routine_id = ${row.hevy_routine_id}
        `;
        changed.push(row.hevy_routine_id);
      } else if (isPresent && status === "missing_on_garmin") {
        await sql`
          UPDATE synced_routines SET status = 'success'
          WHERE hevy_routine_id = ${row.hevy_routine_id}
        `;
        changed.push(row.hevy_routine_id);
      }
    }
  } catch {
    // Best effort, exactly as in Python. A reconcile that cannot run must not
    // fail the sync it is part of.
  }
  return changed;
}

export interface RoutineScheduleResult {
  status: "scheduled" | "error";
  scheduleId: string | null;
  error: string | null;
}

/** Schedule a synced routine's Garmin workout onto a date and record it. */
export async function scheduleRoutine(
  hevyRoutineId: string,
  garminWorkoutId: number | string,
  date: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineScheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const res = await client.post<{ workoutScheduleId?: number }>(
      `/workout-service/schedule/${garminWorkoutId}`,
      { date },
    );
    const scheduleId = res?.workoutScheduleId != null ? String(res.workoutScheduleId) : String(Date.now());
    await sql`
      INSERT INTO routine_schedules (hevy_routine_id, schedule_id, scheduled_date)
      VALUES (${hevyRoutineId}, ${scheduleId}, ${date})
      ON CONFLICT (hevy_routine_id, schedule_id) DO NOTHING
    `;
    return { status: "scheduled", scheduleId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", scheduleId: null, error };
  }
}

export interface RoutineUnscheduleResult {
  status: "unscheduled" | "error";
  error: string | null;
}

/** Remove a Garmin calendar entry (workoutScheduleId) and its local record. */
export async function unscheduleRoutine(
  hevyRoutineId: string,
  scheduleId: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineUnscheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    await garminDelete(client, `/workout-service/schedule/${scheduleId}`);
    await sql`
      DELETE FROM routine_schedules
      WHERE hevy_routine_id = ${hevyRoutineId} AND schedule_id = ${scheduleId}
    `;
    return { status: "unscheduled", error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}
