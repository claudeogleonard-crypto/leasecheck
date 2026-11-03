import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateSlots, todayInZone } from "../netlify/lib/scheduling.mts";
import { queueDecision } from "../netlify/lib/automation.mts";
import { enforceTriageRules } from "../netlify/lib/agents.mts";
import { riskSchema, extractionSchema, triageSchema } from "../netlify/lib/schemas.mts";

test("slots fall on Tue/Thu afternoons only, after the start date", () => {
  const slots = candidateSlots("2026-11-02"); // a Monday
  assert.equal(slots[0].id, "2026-11-03T13:00");
  assert.match(slots[0].label, /^Tue, Nov 3 · 1:00 PM MT$/);
  for (const s of slots) assert.ok([2, 4].includes(new Date(s.id.slice(0, 10) + "T00:00Z").getUTCDay()));
  assert.ok(slots.every((s) => s.id > "2026-11-02"));
});

test("todayInZone uses Mountain Time", () => {
  assert.equal(todayInZone(new Date("2026-11-03T03:00:00Z")), "2026-11-02");
});

const risk = (overall: any, sev: any = "low") => ({
  overall_risk: overall, risk_score: 50, rationale: "",
  flags: [{ severity: sev, category: "other", title: "t", explanation: "", quote: "", legal_note: "" }],
  occupancy: { tenants_on_lease: 2, bedrooms: 2, concern_level: "none", notes: "" },
}) as any;
const tri = (attorney: boolean, urgency: any = "routine") => ({
  attorney_review_needed: attorney, urgency, triage_reason: "r", plain_language_summary: "", key_numbers: [], questions_for_landlord: [], next_steps: [],
}) as any;

test("high risk always requires attorney review", () => {
  const t = enforceTriageRules(risk("high"), tri(false));
  assert.equal(t.attorney_review_needed, true);
  assert.equal(t.urgency, "soon");
  assert.equal(enforceTriageRules(risk("medium", "high"), tri(false)).attorney_review_needed, true);
  assert.equal(enforceTriageRules(risk("low"), tri(false)).attorney_review_needed, false);
});

test("queue decision: high risk queued, attorney-flagged medium queued, clean not queued", () => {
  assert.deepEqual(queueDecision({ risk: risk("high"), triage: tri(true, "urgent") } as any).priority, 1);
  assert.equal(queueDecision({ risk: risk("medium"), triage: tri(true) } as any).queue, true);
  assert.equal(queueDecision({ risk: risk("low"), triage: tri(false) } as any).queue, false);
});

test("schemas are strict (all properties required, no extras)", () => {
  const walk = (s: any) => {
    if (s?.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s?.type === "array") walk(s.items);
  };
  [extractionSchema, riskSchema, triageSchema].forEach(walk);
});
