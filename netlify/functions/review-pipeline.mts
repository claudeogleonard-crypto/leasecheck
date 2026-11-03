// Background function: runs the three agents in order (Extraction, Risk, Triage),
// saving progress after each step, then hands off to the review-completed automation.
// Background functions can run up to 15 minutes, well beyond three Claude calls.
import type { Config, Context } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, assessRisk, enforceTriageRules, extract, triage, type LeaseInput } from "../lib/agents.mts";
import { callInternal, isInternal } from "../lib/http.mts";
import { getReview, inputsStore, now, saveReview, type ReviewRecord, type StepName } from "../lib/store.mts";

async function step<T>(r: ReviewRecord, name: StepName, fn: () => Promise<T>): Promise<T> {
  r.steps[name] = { status: "running", startedAt: now() };
  await saveReview(r);
  const out = await fn();
  r.steps[name] = { ...r.steps[name], status: "done", finishedAt: now() };
  return out;
}

function friendlyError(e: unknown): string {
  if (e instanceof AgentError) return e.message;
  if (e instanceof Anthropic.RateLimitError) return "The AI service is busy right now. Please try again in a few minutes.";
  if (e instanceof Anthropic.AuthenticationError) return "The server's AI credentials are invalid. Please contact Off-Campus Housing.";
  if (e instanceof Anthropic.BadRequestError) return "The document could not be processed. If it's a scanned PDF, try pasting the text.";
  if (e instanceof Anthropic.APIError) return `The AI service returned an error (${e.status}). Please try again.`;
  return "Something went wrong while reviewing the lease. Please try again.";
}

export default async (req: Request, _context: Context) => {
  if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
  const { id } = await req.json();
  const r = await getReview(id);
  if (!r || r.status !== "queued") return; // missing, or already processed (e.g. a retry)

  const input = (await inputsStore().get(id, { type: "json" })) as LeaseInput | null;
  if (!input) return;

  const client = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
  r.status = "running";

  try {
    r.extraction = await step(r, "extraction", () => extract(client, input));
    await saveReview(r);
    r.risk = await step(r, "risk", () => assessRisk(client, input, r.extraction!));
    await saveReview(r);
    const t = await step(r, "triage", () => triage(client, r.extraction!, r.risk!));
    r.triage = enforceTriageRules(r.risk, t);
    r.status = "reviewed";
    await saveReview(r);
  } catch (e) {
    console.error(`Review ${id} failed`, e);
    for (const s of Object.values(r.steps)) if (s.status === "running") s.status = "failed";
    r.status = "failed";
    r.error = friendlyError(e);
    await saveReview(r);
    return;
  }

  // Event hand-off: "review finished" triggers the separate automation function.
  try {
    await callInternal(req, "/api/internal/review-completed", { id });
  } catch (e) {
    console.error(`Could not trigger automation for ${id}`, e);
    r.steps.automation = { status: "failed" };
    await saveReview(r);
  }
};

export const config: Config = { path: "/api/internal/pipeline", background: true };
