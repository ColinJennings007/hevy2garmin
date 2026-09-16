/**
 * Recovery for stuck in-flight uploads — the counterpart to syncOneWorkout for
 * a SPECIFIC pending workout rather than the next candidate.
 *
 *   reconcile — a Garmin READ: check whether Garmin already has an activity at
 *     the workout's start time. If it does, the earlier attempt actually
 *     landed, so complete the pending as a matched success (no re-upload).
 *     Otherwise leave the pending in place and record that nothing was found.
 *
 *   retry — reconcile first (never double-upload), and only if Garmin still has
 *     nothing, regenerate the FIT from the stored payload and re-upload, then
 *     finalize. A Garmin WRITE — the host gates it behind auth + confirmation.
 */
import { generateFit, type HevyWorkout as FitWorkout } from "../fit";
import { toUtcDate } from "../match";
import { generateDescription } from "./description";
import type { SyncDeps } from "./gateway";
import type { PendingRecord, RecoveryOptions, RecoveryResult } from "./types";

interface StoredPayload {
  workout?: Record<string, unknown>;
  title?: string;
  calories?: number;
  avg_hr?: number | null;
  description_enabled?: boolean;
  description?: string;
  sync_method?: string;
}

/** Park for review after this many failed deletes rather than retrying for ever. */
const MAX_DELETE_ATTEMPTS = 3;

function payloadOf(pending: PendingRecord): StoredPayload {
  const p = pending.payload;
  return p && typeof p === "object" ? (p as StoredPayload) : {};
}

function startTimeOf(workout: Record<string, unknown> | undefined): string | null {
  const s = workout?.start_time;
  return typeof s === "string" && s ? s : null;
}

type RecoveryDeps = Pick<SyncDeps, "store" | "gateway">;

/** Complete a pending as a matched Garmin activity (no upload). */
async function completeMatched(deps: RecoveryDeps, hevyId: string, pl: StoredPayload, activityId: number): Promise<void> {
  await deps.store.completePending(hevyId, {
    garminActivityId: String(activityId),
    title: pl.title ?? "",
    calories: pl.calories ?? null,
    avgHr: pl.avg_hr ?? null,
    syncMethod: "match",
  });
}

/**
 * Resume remote finalization from a durable checkpoint. Never uploads.
 *
 * A four-step machine over `next_step`, rename then description then delete
 * then commit, checkpointing after each so a crash resumes where it stopped
 * instead of starting again. Ported from `finalize_pending` in
 * `src/hevy2garmin/sync.py:116`.
 *
 * The delete is the step this exists for. A replace uploads a named activity
 * and then removes the watch copy, so a run that dies between those two leaves
 * the user with two activities for one workout, for ever. Nothing else cleans
 * that up: reconcile will not, and a later sync will not either because the
 * workout is already in the ledger.
 */
export async function finalizePending(deps: RecoveryDeps, hevyId: string): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };

  const activityId = Number(pending.garmin_activity_id);
  if (!Number.isFinite(activityId) || activityId <= 0) {
    return { status: "no_payload", garminActivityId: null, error: null };
  }

  const pl = payloadOf(pending);
  const watchId = pending.watch_activity_id;
  const gateway = await deps.gateway();
  let step = pending.next_step || "rename";

  try {
    if (step === "rename") {
      await gateway.rename(activityId, pl.title ?? "Workout");
      step = pl.description_enabled ? "description" : watchId ? "delete" : "commit";
      await deps.store.updatePending(hevyId, { phase: "finalizing", next_step: step, last_error: null });
    }

    if (step === "description") {
      const workout = pl.workout ?? {};
      await gateway.describe(
        activityId,
        pl.description ?? generateDescription(workout, pl.calories ?? 0, pl.avg_hr ?? null),
      );
      step = watchId ? "delete" : "commit";
      await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
    }

    if (step === "delete") {
      if (!watchId) {
        step = "commit";
        await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
      } else if (Number(watchId) === activityId) {
        // Deleting here would destroy the activity just created, leaving the
        // workout on neither side. A person decides instead.
        await deps.store.updatePending(hevyId, {
          phase: "needs_review",
          last_error: "replacement equals watch activity; deletion blocked",
        });
        return { status: "needs_review", garminActivityId: activityId, error: null };
      } else {
        try {
          await gateway.deleteActivity(Number(watchId));
        } catch (err) {
          // Count rather than retry for ever. Three failures against a Garmin
          // that keeps refusing is a person's problem, not a loop's.
          const attempts = (pending.delete_attempt_count ?? 0) + 1;
          const exhausted = attempts >= MAX_DELETE_ATTEMPTS;
          await deps.store.updatePending(hevyId, {
            phase: exhausted ? "needs_review" : "finalizing",
            next_step: "delete",
            delete_attempt_count: attempts,
            last_error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          });
          return {
            status: exhausted ? "needs_review" : "processing",
            garminActivityId: activityId,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        // Python also removes it from intervals.icu here so the deleted copy
        // does not linger there. That whole integration is unported and is
        // #586, so it is deliberately absent rather than forgotten.
        step = "commit";
        await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
      }
    }

    await deps.store.completePending(hevyId, {
      garminActivityId: String(activityId),
      title: pl.title ?? "",
      calories: pl.calories ?? null,
      avgHr: pl.avg_hr ?? null,
      syncMethod: pl.sync_method ?? "upload",
    });
    return { status: "synced", garminActivityId: activityId, error: null };
  } catch (err) {
    // Park at the step that failed, so the next run resumes there.
    const message = err instanceof Error ? err.message : String(err);
    await deps.store
      .updatePending(hevyId, { phase: "finalizing", next_step: step, last_error: message.slice(0, 1000) })
      .catch(() => {});
    return { status: "processing", garminActivityId: activityId, error: message };
  }
}

export async function reconcilePending(deps: RecoveryDeps, hevyId: string): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };

  // Garmin refused this import. There is nothing to find and looking wastes a
  // rate-limited call, so say so and stop.
  if (pending.phase === "failed") {
    return { status: "failed", garminActivityId: null, error: pending.last_error ?? null };
  }

  // The activity is already known, so this is a resume rather than a search.
  if (pending.garmin_activity_id) return finalizePending(deps, hevyId);

  const pl = payloadOf(pending);
  const startTime = startTimeOf(pl.workout);
  if (!startTime) return { status: "no_payload", garminActivityId: null, error: null };

  // Adopting an activity means recording it as the one we created. Get that
  // wrong and the workout is marked synced against something that is not ours,
  // which reads as success and is unrecoverable without the user noticing.
  //
  // Python guards it three ways and we carry two of them. The third resolves
  // the activity from the upload id, and it is NOT ported on purpose: it calls
  // `get_upload_status` / `get_activity_from_upload` behind a
  // `getattr(client, name, None)` check, and neither method exists on the
  // garminconnect client this project installs, so that branch never runs on
  // either side. Porting it would mean inventing an endpoint the reference
  // never calls, on the one path where a wrong answer is unrecoverable.
  const excluded = new Set<string>((pending.pre_upload_ids ?? []).map((x) => String(x)));
  if (pending.watch_activity_id) excluded.add(String(pending.watch_activity_id));

  // Without evidence that an upload was ever attempted, anything sitting at
  // this start time belongs to someone else. Refuse rather than guess.
  const hasRecoveryEvidence = Boolean(
    pending.upload_id ||
      (pending.pre_upload_ids ?? []).length ||
      (["processing", "finalizing", "needs_review"].includes(pending.phase) &&
        (pending.attempt_count ?? 0) > 0),
  );
  if (!hasRecoveryEvidence) {
    await deps.store.updatePending(hevyId, {
      phase: "needs_review",
      last_error: "no upload attempt checkpoint; refusing snapshot adoption",
    });
    return { status: "needs_review", garminActivityId: null, error: null };
  }

  const gateway = await deps.gateway();
  const target = toUtcDate(startTime);
  if (!target) return { status: "no_payload", garminActivityId: null, error: null };
  const day = (d: Date, off: number) => new Date(d.getTime() + off * 86_400_000).toISOString().slice(0, 10);

  let activities;
  try {
    activities = await gateway.activitiesByDate(day(target, -1), day(target, 1));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.updatePending(hevyId, { last_error: message.slice(0, 1000) }).catch(() => {});
    return { status: "processing", garminActivityId: null, error: message };
  }

  const candidates = activities.filter((a) => a.activityId != null && !excluded.has(String(a.activityId)));

  // Deliberately strict: exactly one activity that we made (DEVELOPMENT),
  // is strength-shaped, and starts when the workout did. Anything else is
  // ambiguous, and ambiguity here is a person's decision.
  const safe = candidates.filter((a) => {
    if (String(a.manufacturer ?? "").toUpperCase() !== "DEVELOPMENT") return false;
    const typeKey = a.activityType?.typeKey ?? "";
    if (!["strength_training", "other"].includes(typeKey)) return false;
    const started = toUtcDate(String(a.startTimeGMT ?? a.startTimeLocal ?? ""));
    return started != null && Math.abs(started.getTime() - target.getTime()) < 10 * 60 * 1000;
  });

  if (safe.length !== 1) {
    if (candidates.length) {
      await deps.store.updatePending(hevyId, {
        phase: "needs_review",
        last_error: `${candidates.length} unverified snapshot candidate(s)`,
      });
      return { status: "needs_review", garminActivityId: null, error: null };
    }
    await deps.store.updatePending(hevyId, { last_error: "reconcile: no matching Garmin activity" });
    return { status: "no_activity", garminActivityId: null, error: null };
  }

  const resolved = Number(safe[0].activityId);
  await deps.store.updatePending(hevyId, {
    phase: "finalizing",
    next_step: "rename",
    garmin_activity_id: String(resolved),
    resolution_source: "snapshot",
    last_error: null,
  });
  return finalizePending(deps, hevyId);
}

export async function retryPending(
  deps: RecoveryDeps,
  hevyId: string,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const workout = pl.workout;
  const startTime = startTimeOf(workout);
  if (!workout || !startTime) return { status: "no_payload", garminActivityId: null, error: null };

  const gateway = await deps.gateway();

  // Never double-upload: if Garmin already has it, complete as matched.
  const existing = await gateway.findExistingActivity(startTime);
  if (existing != null) {
    await completeMatched(deps, hevyId, pl, existing);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }

  try {
    const fit = generateFit(workout as unknown as FitWorkout, null);
    await deps.store.updatePending(hevyId, {
      phase: "processing",
      attempt_count: (pending.attempt_count ?? 0) + 1,
      last_error: null,
    });
    const up = await gateway.upload(fit.fit, startTime);
    const activityId = up.activityId;
    if (activityId != null) {
      await gateway.rename(activityId, pl.title ?? "");
      if (opts.descriptionEnabled !== false) {
        await gateway.describe(activityId, generateDescription(workout, fit.calories, fit.avg_hr));
      }
    }
    await deps.store.completePending(hevyId, {
      garminActivityId: activityId != null ? String(activityId) : null,
      title: pl.title ?? "",
      calories: fit.calories,
      avgHr: fit.avg_hr,
      syncMethod: "upload",
    });
    return { status: "synced", garminActivityId: activityId ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.updatePending(hevyId, { phase: "processing", last_error: message });
    return { status: "error", garminActivityId: null, error: message };
  }
}
