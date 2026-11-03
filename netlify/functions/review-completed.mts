// Background function: the "review completed" automation.
// Triggered whenever the agent pipeline finishes a review. It saves the record,
// queues high-risk leases for an attorney, holds a suggested appointment slot,
// and sends notifications. Netlify retries it on failure, and each step is idempotent.
import type { Config, Context } from "@netlify/functions";
import { runReviewCompletedAutomation } from "../lib/automation.mts";
import { isInternal } from "../lib/http.mts";
import { getReview, saveReview } from "../lib/store.mts";

export default async (req: Request, _context: Context) => {
  if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
  const { id } = await req.json();
  try {
    await runReviewCompletedAutomation(id, new URL(req.url).origin);
  } catch (e) {
    console.error(`Automation failed for ${id}`, e);
    const r = await getReview(id);
    if (r) {
      r.steps.automation = { ...r.steps.automation, status: "failed" };
      await saveReview(r);
    }
    throw e; // let Netlify retry
  }
};

export const config: Config = { path: "/api/internal/review-completed", background: true };
