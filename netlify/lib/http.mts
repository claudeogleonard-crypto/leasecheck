import { createHash, timingSafeEqual } from "node:crypto";

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const error = (message: string, status = 400) => json({ error: message }, status);

export function safeEqual(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Shared secret for internal function-to-function calls. */
export function internalSecret() {
  const explicit = process.env.INTERNAL_SECRET;
  if (explicit) return explicit;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No INTERNAL_SECRET or ANTHROPIC_API_KEY to derive one from.");
  return createHash("sha256").update(`leasecheck-internal:${key}`).digest("hex");
}

export function isInternal(req: Request) {
  try {
    return safeEqual(req.headers.get("x-internal-secret") || "", internalSecret());
  } catch {
    return false; // never accept internal calls without a real secret
  }
}

/** Calls another of this site's functions server-to-server. */
export async function callInternal(req: Request, path: string, body: unknown) {
  const url = new URL(path, req.url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": internalSecret() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Internal call to ${path} failed: HTTP ${res.status}`);
}

/** Staff auth: shared password from STAFF_PASSWORD, sent in the x-staff-key header. */
export function staffAuth(req: Request): Response | null {
  const pw = Netlify.env.get("STAFF_PASSWORD");
  if (!pw) return error("Staff dashboard is not configured (set STAFF_PASSWORD).", 503);
  if (!safeEqual(req.headers.get("x-staff-key") || "", pw)) return error("Unauthorized", 401);
  return null;
}
