// The "review completed" automation, kept separate from the agents.
// Called by the triage function (server-to-server) once triage finishes. It saves the record,
// queues attorney_review leases, attaches a suggested slot, and sends notifications.
// Runs as a normal synchronous function (about a second) so it works on every Netlify plan.
// Each step is idempotent, so calling it again is safe.
import type { Config, Context } from "@netlify/functions";
import { runReviewCompletedAutomation } from "../lib/automation.mts";
import { error, isInternal, json } from "../lib/http.mts";

export default async (req: Request, _context: Context) => {
  if (!isInternal(req)) return error("Forbidden", 403);
  const { id } = await req.json().catch(() => ({}));
  if (!id) return error("Missing id");
  try {
    const r = await runReviewCompletedAutomation(id, new URL(req.url).origin);
    return json({ ok: true, queued: r.automation?.queued ?? false });
  } catch (e) {
    console.error(`Automation failed for ${id}`, e);
    return error("Automation failed", 500);
  }
};

export const config: Config = { path: "/api/internal/review-completed", method: "POST" };
