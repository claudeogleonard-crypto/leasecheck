// Background function (up to 15 minutes): runs the three agents and the automation for one review.
// The caller gets 202 immediately; progress is saved to Blobs and polled via /api/reviews/:id.
// Safe against duplicate or forged triggers: it only runs a review whose status is "queued" for the
// given attempt, and takes a one-time lock first.
import type { Config, Context } from "@netlify/functions";
import { runPipeline } from "../lib/pipeline.mts";

export default async (req: Request, _context: Context) => {
  const { id, attempt } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || typeof attempt !== "number") return;
  try {
    await runPipeline(id, attempt, new URL(req.url).origin);
  } catch (e) {
    // Don't rethrow: a Netlify retry would be refused by the lock anyway, and the record shows the error.
    console.error(`run-review crashed for ${id}`, e);
  }
};

export const config: Config = { path: "/api/internal/run-review", background: true };
