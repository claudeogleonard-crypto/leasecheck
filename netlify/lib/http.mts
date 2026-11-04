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

/** Staff auth: shared password from STAFF_PASSWORD, sent in the x-staff-key header. */
export function staffAuth(req: Request): Response | null {
  const pw = Netlify.env.get("STAFF_PASSWORD");
  if (!pw) return error("Staff dashboard is not configured (set STAFF_PASSWORD).", 503);
  if (!safeEqual(req.headers.get("x-staff-key") || "", pw)) return error("Unauthorized", 401);
  return null;
}
