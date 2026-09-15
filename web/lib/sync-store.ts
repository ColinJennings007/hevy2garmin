/**
 * The Postgres implementation of the engine's `SyncStore` boundary.
 *
 * The sync engine (`hevy2garmin` package) never touches a database; it reads
 * and writes its ledger through `SyncStore`. This adapter binds that interface
 * to the raw SQL helpers in `./pending-store` for one `sql` connection, so a
 * route builds a store from its `getDb()` tag and hands it to the engine.
 * Everything here is local bookkeeping: NOTHING calls Garmin or Hevy.
 */
import type { MarkSyncedOpts, PendingUpdate, SyncLogEntry, SyncStore } from "hevy2garmin";
import {
  claimPending,
  completePending,
  deletePending,
  getPending,
  isSynced,
  loadPendingIds,
  loadSyncedIds,
  markSynced,
  updatePending,
  type Sql,
} from "./pending-store";

export function postgresSyncStore(sql: Sql): SyncStore {
  return {
    isSynced: (hevyId) => isSynced(hevyId, sql),
    loadSyncedIds: () => loadSyncedIds(sql),
    loadPendingIds: () => loadPendingIds(sql),
    getPending: (hevyId) => getPending(hevyId, sql),
    claimPending: (hevyId, payload) => claimPending(hevyId, payload, sql),
    updatePending: (hevyId, fields: PendingUpdate) => updatePending(hevyId, fields, sql),
    deletePending: (hevyId) => deletePending(hevyId, sql),
    completePending: (hevyId, opts: MarkSyncedOpts) => completePending(hevyId, opts, sql),
    markSynced: (hevyId, opts: MarkSyncedOpts) => markSynced(hevyId, opts, sql),
    recordSyncLog: (entry: SyncLogEntry) => recordSyncLog(entry, sql),
  };
}

/**
 * Append one row to `sync_log`, the table the dashboard's Sync log panel reads.
 *
 * Nothing on this path ever wrote to it, so the panel said "No sync runs
 * recorded yet" while syncs were plainly happening, and a user read that as
 * proof his setup was broken (#565). Mirrors `record_sync_log` in
 * `syncstate.py`, including the column defaults.
 */
async function recordSyncLog(entry: SyncLogEntry, sql: Sql): Promise<void> {
  await sql`
    INSERT INTO sync_log (synced, skipped, failed, trigger)
    VALUES (${entry.synced}, ${entry.skipped}, ${entry.failed}, ${entry.trigger})
  `;
}
