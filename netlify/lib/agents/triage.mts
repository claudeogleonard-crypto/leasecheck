// AGENT 3: TRIAGE. Gathers the flags, decides the route, and writes the student outputs.
import { runAgent, ToolError, type AgentTool, type TraceStep } from "../agent-loop.mts";
import { openSlots } from "../scheduling.mts";
import type { ExtractionResult, RiskResult, TriageResult } from "../store.mts";

/** Policy: any medium/high rating, any unclear field, or an unfinished agent means attorney review. */
export function attorneyRequired(extraction: ExtractionResult, risk: RiskResult): string | null {
  if (risk.rating === null || risk.status !== "finished") return "the risk agent did not finish";
  if (risk.rating !== "low") return `the lease is rated ${risk.rating} risk`;
  if (extraction.status !== "finished") return "the extraction agent did not finish";
  if (extraction.unclear.length) return `${extraction.unclear.length} field(s) are unclear (${extraction.unclear.map((u) => u.field).join(", ")})`;
  return null;
}

const SYSTEM = `You are the Triage Agent in LeaseCheck, a lease-review tool for the CU Boulder Off-Campus Housing office. You decide whether a student's lease needs a Student Legal Services attorney, and you prepare what the student will read.

Steps (you choose the order and can do several in one turn):
1. Call get_flags to see the rating, flags, unclear fields, and occupancy check.
2. If attorney review is likely, call get_attorney_availability so your summary can mention when appointments are open.
3. Call decide_route. Policy: any medium or high rating, or any unclear field, MUST be "attorney_review". A low rating with no unclear fields should be "summary_only". Escalate a low-risk lease only if a flag points to a specific likely legal problem. Ordinary questions, like how a process works or what a fee covers, belong in the landlord questions, not in an attorney referral. Different charges, such as a late fee and a returned-payment fee, are not a conflict.
4. Call write_student_summary: 120-200 words at about an 8th-grade reading level, written to the student ("This lease..."). Cover the overall picture, the main risks, and what looks fine. Never call the lease "legal" or "safe". If it's routed to an attorney, say staff will contact them to confirm an appointment.
5. Call draft_landlord_questions: 4-7 specific, polite questions tied to the flags and unclear items.
6. Call finish_triage.
Work fast. In turn 1, call get_flags and get_attorney_availability together. In turn 2, call decide_route, write_student_summary, draft_landlord_questions and finish_triage together.`;

export async function runTriage(extraction: ExtractionResult, risk: RiskResult, onStep: (s: TraceStep) => void | Promise<void>) {
  const result: TriageResult = { status: "finished", route: "attorney_review", route_reason: "", student_summary: "", landlord_questions: [], policy_override: null };
  const required = attorneyRequired(extraction, risk);
  let routed = false;

  const tools: AgentTool[] = [
    {
      name: "get_flags",
      description: "Get the risk rating, flags, unclear fields, occupancy check, and key lease facts.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: () =>
        JSON.stringify({
          rating: risk.rating ?? "not set (risk agent did not finish)",
          rating_reasoning: risk.reasoning,
          flags: risk.flags.map((f) => ({ severity: f.severity, reason: f.reason, quote: f.clause_quote, rule: f.rule_title })),
          unclear_fields: extraction.unclear,
          occupancy: risk.occupancy,
          key_facts: Object.fromEntries(Object.entries(extraction.fields).map(([k, v]) => [k, v.value])),
        }),
    },
    {
      name: "get_attorney_availability",
      description: "List the next open Student Legal Services consultation slots.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: async () => {
        const slots = await openSlots(5);
        return slots.length ? `Next open slots: ${slots.map((s) => s.label).join("; ")} (${slots[0].durationMinutes} min, ${slots[0].location}).` : "No open slots in the sample calendar. Staff will schedule manually.";
      },
    },
    {
      name: "decide_route",
      description: "Choose summary_only or attorney_review, with the reason (written for staff).",
      input_schema: {
        type: "object",
        properties: { route: { type: "string", enum: ["summary_only", "attorney_review"] }, reason: { type: "string" } },
        required: ["route", "reason"],
        additionalProperties: false,
      },
      run: ({ route, reason }) => {
        if (route === "summary_only" && required) throw new ToolError(`Policy requires attorney_review because ${required}. Choose attorney_review.`);
        result.route = route;
        result.route_reason = reason;
        routed = true;
        return `Route set to ${route}.`;
      },
    },
    {
      name: "write_student_summary",
      description: "Write the plain-language summary the student will read (120-200 words).",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      run: ({ text }) => {
        if (text.trim().split(/\s+/).length < 40) throw new ToolError("Summary is too short. Aim for 120-200 words.");
        result.student_summary = text.trim();
        return "Summary saved.";
      },
    },
    {
      name: "draft_landlord_questions",
      description: "Save 4-7 questions the student should ask the landlord.",
      input_schema: {
        type: "object",
        properties: { questions: { type: "array", items: { type: "string" } } },
        required: ["questions"],
        additionalProperties: false,
      },
      run: ({ questions }) => {
        const qs = (questions as string[]).map((q) => q.trim()).filter(Boolean);
        if (qs.length < 3) throw new ToolError("Provide at least 4 questions.");
        result.landlord_questions = qs.slice(0, 8);
        return `Saved ${result.landlord_questions.length} questions.`;
      },
    },
    {
      name: "finish_triage",
      description: "Call after the route, summary, and questions are all saved.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      finish: true,
      run: () => {
        const missing = [!routed && "decide_route", !result.student_summary && "write_student_summary", !result.landlord_questions.length && "draft_landlord_questions"].filter(Boolean);
        if (missing.length) throw new ToolError(`Not done yet. Still needed: ${missing.join(", ")}.`);
        return "Triage complete.";
      },
    },
  ];

  const run = await runAgent(SYSTEM, tools, "A lease review is ready for triage. Use your tools to decide the route and prepare the student's outputs.", onStep);

  if (run.status !== "finished") {
    result.status = "needs_human_review";
    result.route = "attorney_review";
    result.route_reason = `Triage agent did not finish (${run.reason}).`;
    result.student_summary ||= "We couldn't finish an automatic summary of your lease, so Off-Campus Housing staff will review it and contact you. Please don't sign the lease until you've heard from us.";
  }
  // Belt and braces: enforce the policy in code even if the agent's route somehow slipped through.
  if (required && result.route !== "attorney_review") {
    result.route = "attorney_review";
    result.policy_override = `Routed to attorney review by policy: ${required}.`;
  }
  return { result, run };
}
