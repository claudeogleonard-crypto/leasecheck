// Shared handler for the three agent functions. Each request runs ONE agent and streams its
// steps as NDJSON so the student sees the agent's decisions live. Results are saved to Blobs;
// the browser only passes the review id, so it can't tamper with agent outputs.
import { runExtraction } from "./agents/extraction.mts";
import { runRisk } from "./agents/risk.mts";
import { runTriage } from "./agents/triage.mts";
import type { TraceStep } from "./agent-loop.mts";
import { callInternal, error } from "./http.mts";
import { getLeaseInput, getReview, now, saveReview, type AgentName, type ReviewRecord } from "./store.mts";

const ORDER: AgentName[] = ["extraction", "risk", "triage"];
const STALE_RUN_MS = 70_000;

function friendlyError(e: any): string {
  const status = e?.status as number | undefined;
  if (status === 401) return "The server's AI credentials are missing or invalid. Please contact Off-Campus Housing.";
  if (status === 429) return "The AI service is busy right now. Please try again in a minute.";
  if (status && status >= 500) return "The AI service had a temporary problem. Please try again.";
  if (e?.name === "APIConnectionTimeoutError") return "The AI service took too long to respond. Please try again.";
  return "Something went wrong while running this agent. Please try again.";
}

export async function handleAgent(agent: AgentName, req: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return error("Server is missing ANTHROPIC_API_KEY.", 503);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return error("Invalid review id.");

  const r = await getReview(id);
  if (!r) return error("Review not found.", 404);
  const idx = ORDER.indexOf(agent);
  if (idx > 0 && r.steps[ORDER[idx - 1]].status !== "done") return error(`Run the ${ORDER[idx - 1]} agent first.`, 409);
  const step = r.steps[agent];
  if (step.status === "done") return error(`The ${agent} agent already finished for this review.`, 409);
  if (step.status === "running" && step.startedAt && Date.now() - Date.parse(step.startedAt) < STALE_RUN_MS) {
    return error(`The ${agent} agent is already running for this review.`, 409);
  }
  const lease = await getLeaseInput(id);
  if (!lease) return error("Lease text not found.", 404);

  r.status = "running";
  r.steps[agent] = { status: "running", startedAt: now() };
  r.traces[agent] = [];
  delete r.error;
  await saveReview(r);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const onStep = (s: TraceStep) => {
        r.traces[agent]!.push(s);
        send({ type: "step", agent, step: s });
      };
      try {
        await runOne(agent, r, lease, onStep);
        r.steps[agent] = { ...r.steps[agent], status: "done", finishedAt: now() };
        if (agent === "triage") r.status = "reviewed";
        await saveReview(r);
        if (agent === "triage") {
          // Hand off to the separate automation (background function).
          try {
            await callInternal(req, "/api/internal/review-completed", { id });
          } catch (e) {
            console.error("automation trigger failed", e);
            r.steps.automation = { status: "failed", error: "Could not start follow-up automation." };
            await saveReview(r);
          }
        }
        send({ type: "done", agent, record: publicRecord(r) });
      } catch (e: any) {
        console.error(`${agent} agent failed for ${id}:`, e?.status ?? "", e?.message ?? e);
        const message = friendlyError(e);
        r.steps[agent] = { ...r.steps[agent], status: "failed", error: message };
        r.status = "failed";
        r.error = message;
        await saveReview(r).catch(() => {});
        send({ type: "error", agent, message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

async function runOne(agent: AgentName, r: ReviewRecord, lease: Awaited<ReturnType<typeof getLeaseInput>> & {}, onStep: (s: TraceStep) => void) {
  if (agent === "extraction") {
    r.extraction = (await runExtraction(lease, onStep)).result;
  } else if (agent === "risk") {
    r.risk = (await runRisk(lease, r.extraction!, onStep)).result;
  } else {
    r.triage = (await runTriage(r.extraction!, r.risk!, onStep)).result;
  }
}

/** Record as shown to the student (no contact details). */
export function publicRecord(r: ReviewRecord) {
  const { input, ...rest } = r;
  return { ...rest, input: { source: input.source, fileName: input.fileName, bedrooms: input.bedrooms } };
}
