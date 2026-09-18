"use client";

import { useEffect, useState } from "react";

/**
 * The timezone, asked for during setup (#639).
 *
 * It used to live only in Settings, and the README documented it under "My
 * activity shows the wrong time on Strava" — a symptom you meet after a batch of
 * workouts is already on Garmin at the wrong time. Asking here moves it before
 * the damage.
 *
 * The browser knows the answer, so in the normal case there is nothing to type
 * and the only action is Save. The value goes to the same `user_profile.timezone`
 * the Settings form writes, and `saveConfigKey` merges, so nothing else in the
 * profile is disturbed.
 */
export function SetupTimezone({ current }: { current: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const [guessed, setGuessed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only on the client, and only when nothing is stored: a value the user
    // already chose must never be overwritten by the browser's guess.
    if (current) return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) {
        setValue(tz);
        setGuessed(true);
      }
    } catch {
      /* a browser that cannot say is no worse than the old blank field */
    }
  }, [current]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_profile: { timezone: value.trim() } }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSaved(true);
      setGuessed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-sm text-text-secondary">
        Your workouts carry this as their local time. Without it a 6am session can appear at
        3am once Garmin passes it to Strava.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="setup-timezone"
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
            setGuessed(false);
          }}
          placeholder="e.g. Europe/Athens"
          aria-label="Timezone (IANA)"
          className="min-w-[16rem] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {guessed && !saved && (
        <p className="mt-2 text-xs text-text-muted">
          Filled in from your browser. Press Save to keep it.
        </p>
      )}
      {current && !saved && (
        <p className="mt-2 text-xs text-text-muted">Currently saved as {current}.</p>
      )}
      {saved && <p className="mt-2 text-xs text-success">Saved.</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
