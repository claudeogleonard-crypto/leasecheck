// The three-agent pipeline: Extraction -> Risk -> Triage.
// Runs server-side only (inside a Netlify background function), so the API key never reaches the browser.
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_PROMPT, RISK_PROMPT, TRIAGE_PROMPT } from "./prompts.mts";
import {
  extractionSchema,
  riskSchema,
  triageSchema,
  type Extraction,
  type RiskAssessment,
  type Triage,
} from "./schemas.mts";

export const MODEL = "claude-opus-5-5";

export interface LeaseInput {
  text?: string; // plain-text lease
  pdfBase64?: string; // PDF lease, base64 (no data: prefix)
  fileName?: string;
  studentNotes?: string; // optional: bedrooms, address, etc. supplied by the student
}

export class AgentError extends Error {
  agent: string;
  retryable: boolean;
  constructor(agent: string, message: string, retryable = false) {
    super(`${agent}: ${message}`);
    this.agent = agent;
    this.retryable = retryable;
  }
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface AgentCall {
  agent: string;
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
  effort: Effort;
}

async function runAgent<T>(client: Anthropic, call: AgentCall): Promise<T> {
  // Streaming avoids HTTP timeouts on long leases. finalMessage() gathers the full response.
  // fallbacks: "default" makes the API retry on a fallback model server-side if a safety classifier declines.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: call.effort,
      format: { type: "json_schema", schema: call.schema },
    },
    system: call.system,
    messages: [{ role: "user", content: call.content }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "refusal") {
    throw new AgentError(call.agent, "The model declined to process this document.");
  }
  if (msg.stop_reason === "max_tokens") {
    throw new AgentError(call.agent, "The response was cut off (document may be too long).");
  }
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError(call.agent, "Returned output that was not valid JSON.", true);
  }
}

function leaseBlocks(input: LeaseInput): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.pdfBase64) {
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 },
      title: input.fileName || "lease.pdf",
    });
  } else if (input.text) {
    blocks.push({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: input.text },
      title: input.fileName || "lease.txt",
    });
  } else {
    throw new AgentError("input", "No lease text or PDF provided.");
  }
  if (input.studentNotes?.trim()) {
    blocks.push({
      type: "text",
      text: `Notes from the student (context only, not part of the lease):\n${input.studentNotes.trim()}`,
    });
  }
  return blocks;
}

export function extract(client: Anthropic, input: LeaseInput) {
  return runAgent<Extraction>(client, {
    agent: "Extraction agent",
    system: EXTRACTION_PROMPT,
    effort: "medium",
    schema: extractionSchema,
    content: [...leaseBlocks(input), { type: "text", text: "Extract the lease data as JSON." }],
  });
}

export function assessRisk(client: Anthropic, input: LeaseInput, extraction: Extraction) {
  return runAgent<RiskAssessment>(client, {
    agent: "Risk agent",
    system: RISK_PROMPT,
    effort: "high",
    schema: riskSchema,
    content: [
      ...leaseBlocks(input),
      {
        type: "text",
        text: `Extraction Agent output:\n${JSON.stringify(extraction, null, 2)}\n\nAssess the risks and rate this lease.`,
      },
    ],
  });
}

export function triage(client: Anthropic, extraction: Extraction, risk: RiskAssessment) {
  return runAgent<Triage>(client, {
    agent: "Triage agent",
    system: TRIAGE_PROMPT,
    effort: "medium",
    schema: triageSchema,
    content: [
      {
        type: "text",
        text: `Extraction Agent output:\n${JSON.stringify(extraction, null, 2)}\n\nRisk Agent output:\n${JSON.stringify(risk, null, 2)}\n\nMake the triage decision and write the student-facing content.`,
      },
    ],
  });
}

/** Keeps the triage decision consistent with the documented rules, even if the model drifts. */
export function enforceTriageRules(risk: RiskAssessment, t: Triage): Triage {
  const anyHighFlag = risk.flags.some((f) => f.severity === "high");
  if ((risk.overall_risk === "high" || anyHighFlag) && !t.attorney_review_needed) {
    return {
      ...t,
      attorney_review_needed: true,
      urgency: t.urgency === "routine" ? "soon" : t.urgency,
      triage_reason: `${t.triage_reason} (Attorney review required by policy: high-risk rating or high-severity flag.)`,
    };
  }
  return t;
}
