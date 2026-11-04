// POST /api/reviews/:id/retry: restarts a failed (or stalled) review from the step that didn't finish.
import type { Config, Context } from "@netlify/functions";
import { error, json } from "../lib/http.mts";
import { AGENT_ORDER, triggerRun } from "../lib/pipeline.mts";
import { getReview, saveReview } from "../lib/store.mts";

const STALL_MS = 3 * 60_000;

export default async (req: Request, context: Context) => {
  const id = context.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id || "")) return error("Invalid review id.");
  const r = await getReview(id);
  if (!r) return error("Review not found.", 404);
  const stalled = (r.status === "running" || r.status === "queued") && Date.now() - Date.parse(r.updatedAt) > STALL_MS;
  if (r.status !== "failed" && !stalled) return error("This review isn't in a state that can be retried.", 409);

  for (const a of [...AGENT_ORDER, "automation"] as const) {
    if (r.steps[a].status !== "done") r.steps[a] = { status: "pending" };
  }
  r.attempt += 1;
  r.status = "queued";
  delete r.error;
  await saveReview(r);
  try {
    await triggerRun(req, id, r.attempt);
  } catch (e) {
    console.error(e);
    r.status = "failed";
    r.error = "Could not restart the review. Please try again.";
    await saveReview(r);
    return error(r.error, 502);
  }
  return json({ ok: true, attempt: r.attempt }, 202);
};

export const config: Config = {
  path: "/api/reviews/:id/retry",
  method: "POST",
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
