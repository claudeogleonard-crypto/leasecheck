// Runs the full review inside ONE background function: Extraction -> Risk -> Triage agents, then the
// separate review-completed automation. Each agent step is saved to Blobs as it happens, so the
// browser can poll /api/reviews/:id and show a live timeline.
import { runExtraction } from "./agents/extraction.mts";
import { runRisk } from "./agents/risk.mts";
import { runTriage } from "./agents/triage.mts";
import type { TraceStep } from "./agent-loop.mts";
import { runReviewCompletedAutomation } from "./automation.mts";
import { getLeaseInput, getReview, locksStore, now, saveReview, type AgentName, type ReviewRecord } from "./store.mts";

export const AGENT_ORDER: AgentName[] = ["extraction", "risk", "triage"];
const SAVE_EVERY_MS = 600; // throttle trace writes while an agent is working

export function friendlyError(e: any): string {
  const status = e?.status as number | undefined;
  if (status === 401) return "The server's AI credentials are missing or invalid. Please contact Off-Campus Housing.";
  if (status === 429) return "The AI service is busy right now. Please try again in a minute.";
  if (status && status >= 500) return "The AI service had a temporary problem. Please try again.";
  if (e?.name === "APIConnectionTimeoutError") return "The AI service took too long to respond. Please try again.";
  return "Something went wrong while reviewing the lease. Please try again.";
}

/** Starts the background run for a review (fire-and-forget; Netlify answers 202 immediately). */
export async function triggerRun(req: Request, id: string, attempt: number) {
  const res = await fetch(new URL("/api/internal/run-review", req.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, attempt }),
  });
  if (!res.ok) throw new Error(`Could not start the review (HTTP ${res.status})`);
}

export async function runPipeline(id: string, attempt: number, origin: string) {
  const r = await getReview(id);
  if (!r || r.status !== "queued" || r.attempt !== attempt) return; // stale or duplicate trigger
  // Lock so a duplicate delivery of the same trigger can never run the agents twice.
  const { modified } = await locksStore().setJSON(`${id}:${attempt}`, { at: now() }, { onlyIfNew: true });
  if (!modified) return;

  const lease = await getLeaseInput(id);
  if (!lease) return fail(r, null, "The lease text could not be found.");
  r.status = "running";
  await saveReview(r);

  for (const agent of AGENT_ORDER) {
    if (r.steps[agent].status === "done") continue; // resume after a retry
    r.steps[agent] = { status: "running", startedAt: now() };
    r.traces[agent] = [];
    await saveReview(r);

    let lastSave = 0;
    let pending: Promise<unknown> = Promise.resolve();
    const onStep = (s: TraceStep) => {
      r.traces[agent]!.push(s);
      if (Date.now() - lastSave > SAVE_EVERY_MS) {
        lastSave = Date.now();
        pending = pending.then(() => saveReview(r)).catch(() => {});
      }
    };
    try {
      if (agent === "extraction") r.extraction = (await runExtraction(lease, onStep)).result;
      else if (agent === "risk") r.risk = (await runRisk(lease, r.extraction!, onStep)).result;
      else r.triage = (await runTriage(r.extraction!, r.risk!, onStep)).result;
      await pending;
    } catch (e) {
      await pending;
      console.error(`${agent} agent failed for ${id}:`, (e as any)?.status ?? "", (e as Error)?.message ?? e);
      return fail(r, agent, friendlyError(e));
    }
    r.steps[agent] = { ...r.steps[agent], status: "done", finishedAt: now() };
    await saveReview(r);
  }

  r.status = "reviewed";
  await saveReview(r);

  // Separate step: the review-completed automation (save, queue, slot, notify).
  try {
    await runReviewCompletedAutomation(id, origin);
  } catch (e) {
    console.error(`automation failed for ${id}`, e);
    const latest = (await getReview(id)) ?? r;
    latest.steps.automation = { ...latest.steps.automation, status: "failed", error: "Follow-up automation failed." };
    latest.status = "failed";
    latest.error = "Your review finished, but the follow-up step (queueing and notifications) failed.";
    await saveReview(latest);
  }
}

async function fail(r: ReviewRecord, agent: AgentName | null, message: string) {
  if (agent) r.steps[agent] = { ...r.steps[agent], status: "failed", error: message };
  r.status = "failed";
  r.error = message;
  await saveReview(r).catch(() => {});
}

/** Record as shown to the student (no contact details). */
export function publicRecord(r: ReviewRecord) {
  const { input, ...rest } = r;
  return { ...rest, input: { source: input.source, fileName: input.fileName, bedrooms: input.bedrooms } };
}
