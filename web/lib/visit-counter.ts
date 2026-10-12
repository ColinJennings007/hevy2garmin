/**
 * Optional visit counter.
 *
 * With COLLECTOR_URL and COLLECTOR_TOKEN both set, each page view is posted in the
 * background to {COLLECTOR_URL}/collect: the page name (COLLECTOR_PAGE, or the request
 * host), the referrer, the user agent and the client IP. It never changes the response,
 * gives up after 1.5 s, and without both variables it does nothing at all, so a fork or
 * a self-hosted copy sends nothing anywhere.
 */

/** Some collectors sit behind Cloudflare, which refuses the runtime's default user agent. */
const USER_AGENT = "estate-collector-client/1.0";
const TIMEOUT_MS = 1500;

type Env = Record<string, string | undefined>;
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** A GET for an HTML page: not /_next, not /api, and not a file with an extension. */
export function isPageView(req: Request, pathname: string): boolean {
  if (req.method !== "GET") return false;
  if (!(req.headers.get("accept") ?? "").includes("text/html")) return false;
  if (pathname.startsWith("/_next") || pathname === "/api" || pathname.startsWith("/api/")) return false;
  const last = pathname.split("/").pop() ?? "";
  return !/\.[A-Za-z0-9]+$/.test(last);
}

/** The body the collector takes. */
export function visitBody(req: Request, env: Env = process.env) {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return {
    page: env.COLLECTOR_PAGE?.trim() || host,
    ref: req.headers.get("referer") || "Unknown",
    agent: req.headers.get("user-agent") ?? "",
    ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim(),
    domain: "",
  };
}

/**
 * Count this request when it is a page view and a collector is configured. Returns the
 * pending post (for tests) or null when nothing is sent. Never throws.
 */
export function countVisit(
  req: Request,
  event: WaitUntil | undefined,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> | null {
  const url = env.COLLECTOR_URL?.trim();
  const token = env.COLLECTOR_TOKEN?.trim();
  if (!url || !token) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return null;
  }
  if (!isPageView(req, pathname)) return null;
  const send = fetchImpl(`${url.replace(/\/+$/, "")}/collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(visitBody(req, env)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(
    () => undefined,
    () => undefined,
  );
  event?.waitUntil(send);
  return send;
}
