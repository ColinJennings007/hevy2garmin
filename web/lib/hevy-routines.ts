/**
 * Fetch the user's Hevy routines. READ-ONLY.
 *
 * This reached the Hevy REST API directly and so inherited none of what
 * `HevyClient.get` gives every other Hevy call. Four things were missing and
 * all four are fixed here (#606):
 *
 *   - retry, so a single 429 ended the fetch
 *   - honesty about failure: a later page failing returned whatever had been
 *     collected, so a rate-limited fragment of twelve routines could not be
 *     told apart from a complete list of four, and the routine sync then
 *     reported that fragment's size as the total
 *   - a page cap of five, silently dropping anything past fifty routines
 *   - `HevyAuthError`, so a 401 surfaced as a bare status code instead of the
 *     named error carrying the fix (check Hevy Pro, regenerate the key)
 *   - the pacing between calls, against an API that rate-limits
 *
 * WHY THIS IS STILL HERE rather than a call to `client.getAllRoutines()`, which
 * this same PR adds to the package: `web` pins `hevy2garmin@^0.8.0`, and that
 * version's client has neither the method nor the options argument. Delegating
 * today would typecheck against the new source and fail at runtime against the
 * installed one, which would break routine syncing outright.
 *
 * So the behaviour is fixed here now, and the package method exists for the
 * engine and for the moment the pin moves. At that point this whole file
 * becomes a two-line delegate, and the tests beside it should keep passing
 * unchanged.
 */
import { HevyAuthError } from "hevy2garmin";
import { resolveHevyKey } from "./hevy-sync";
import type { HevyRoutine } from "./garmin-workout";

const HEVY_BASE = "https://api.hevyapp.com/v1";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export interface FetchRoutinesOptions {
  fetchImpl?: typeof fetch;
  /** Injectable so tests neither stub globals nor wait out the real backoff. */
  retryBackoffMs?: number;
  callDelayMs?: number;
}

/** One page, with the client's retry, auth handling and pacing. */
async function getPage(
  apiKey: string,
  page: number,
  pageSize: number,
  opts: Required<Pick<FetchRoutinesOptions, "retryBackoffMs" | "callDelayMs">> & {
    fetchImpl: typeof fetch;
  },
): Promise<{ routines?: HevyRoutine[]; page_count?: number }> {
  const url = `${HEVY_BASE}/routines?page=${page}&pageSize=${pageSize}`;
  let res!: Response;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await opts.fetchImpl(url, {
      headers: { "api-key": apiKey, accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      throw new HevyAuthError(
        "Hevy API key invalid or expired (check Hevy Pro + regenerate at hevy.com/settings).",
      );
    }
    if (RETRY_STATUS.has(res.status)) {
      await sleep(opts.retryBackoffMs * (attempt + 1));
      continue;
    }
    break;
  }
  // Throws rather than returning what it had. A caller cannot tell a short list
  // from a truncated one, so the only honest answer to a failed page is an error.
  if (!res.ok) throw new Error(`Hevy GET /routines → ${res.status}`);
  await sleep(opts.callDelayMs);
  return res.json() as Promise<{ routines?: HevyRoutine[]; page_count?: number }>;
}

export async function fetchHevyRoutines(
  key?: string | null,
  opts: FetchRoutinesOptions = {},
): Promise<HevyRoutine[]> {
  const apiKey = await resolveHevyKey(key);
  if (!apiKey) throw new Error("No Hevy API key available.");

  const bound = {
    fetchImpl: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    retryBackoffMs: opts.retryBackoffMs ?? 2000,
    callDelayMs: opts.callDelayMs ?? 500,
  };

  const routines: HevyRoutine[] = [];
  // No page cap. The old one stopped at five pages, so a user with more than
  // fifty routines lost the rest with no error and no indication.
  for (let page = 1; ; page++) {
    const data = await getPage(apiKey, page, 10, bound);
    const batch = Array.isArray(data.routines) ? data.routines : [];
    routines.push(...batch);
    if (!batch.length || (typeof data.page_count === "number" && page >= data.page_count)) break;
  }
  return routines;
}
