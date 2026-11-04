import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAgent, ToolError, type AgentTool } from "../netlify/lib/agent-loop.mts";
import { MAX_TURNS } from "../netlify/lib/config.mts";
import { quoteInText, searchPassages, splitPassages } from "../netlify/lib/lease-search.mts";
import { checkOccupancy, RULES } from "../netlify/lib/agents/risk.mts";
import { attorneyRequired } from "../netlify/lib/agents/triage.mts";
import { futureSlotIds, nowInZone, toSlot } from "../netlify/lib/scheduling.mts";

const high = readFileSync("public/samples/high-risk-lease.txt", "utf8");
const clean = readFileSync("public/samples/clean-lease.txt", "utf8");

/** Fake Messages API client that replays scripted responses. */
function fakeClient(script: any[][]) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    messages: {
      create: async (req: any) => {
        requests.push(structuredClone(req));
        const content = script[Math.min(i++, script.length - 1)];
        const hasTool = content.some((b: any) => b.type === "tool_use");
        return { content, stop_reason: hasTool ? "tool_use" : "end_turn" };
      },
    },
  } as any;
}
const use = (name: string, input: any, id = `tu_${name}_${Math.random()}`) => ({ type: "tool_use", id, name, input });

test("runAgent runs tools, returns errors to the model, and stops on the finish tool", async () => {
  let finishCalls = 0;
  const tools: AgentTool[] = [
    { name: "search", description: "", input_schema: { type: "object", properties: {} }, run: () => "found it" },
    { name: "finish", description: "", input_schema: { type: "object", properties: {} }, finish: true,
      run: () => { if (++finishCalls === 1) throw new ToolError("not yet"); return "done"; } },
  ];
  const client = fakeClient([
    [{ type: "thinking", thinking: "", signature: "sig" }, use("search", { q: "rent" }), use("search", { q: "fees" })],
    [use("finish", {})],
    [{ type: "text", text: "Finishing now." }, use("finish", {})],
  ]);
  const steps: any[] = [];
  const run = await runAgent("sys", tools, "go", (s) => { steps.push(s); }, client);
  assert.equal(run.status, "finished");
  assert.equal(run.turns, 3);
  assert.deepEqual(run.trace.filter((s) => s.kind === "tool").map((s) => s.tool), ["search", "search", "finish", "finish"]);
  assert.equal(run.trace.find((s) => s.tool === "finish")!.isError, true);
  assert.equal(steps.length, run.trace.length);
  // Both parallel tool results return in ONE user message; thinking blocks are passed back unchanged.
  const second = client.requests[1].messages;
  assert.equal(second[1].content[0].type, "thinking");
  assert.equal(second[2].content.length, 2);
  assert.ok(second[2].content.every((b: any) => b.type === "tool_result"));
  assert.equal(client.requests[2].messages.at(-1).content[0].is_error, true);
  assert.ok(client.requests[0].tools.every((t: any) => t.strict === true));
});

test("runAgent stops after MAX_TURNS with needs_human_review", async () => {
  const tools: AgentTool[] = [{ name: "search", description: "", input_schema: { type: "object", properties: {} }, run: () => "x" }];
  const run = await runAgent("sys", tools, "go", () => {}, fakeClient([[use("search", {})]]));
  assert.equal(run.status, "needs_human_review");
  assert.equal(run.turns, MAX_TURNS);
  assert.match(run.trace.at(-1)!.result, /Needs human review/);
});

test("runAgent nudges when the model answers without a tool call", async () => {
  const tools: AgentTool[] = [{ name: "done", description: "", input_schema: { type: "object", properties: {} }, finish: true, run: () => "ok" }];
  const client = fakeClient([[{ type: "text", text: "All set!" }], [use("done", {})]]);
  const run = await runAgent("sys", tools, "go", () => {}, client);
  assert.equal(run.status, "finished");
  assert.match(client.requests[1].messages.at(-1).content, /finish tool/);
});

test("search finds the right passages and quotes are verified", () => {
  const p = splitPassages(high);
  assert.match(searchPassages(p, "late charges")[0].text, /LATE CHARGES/);
  assert.match(searchPassages(p, "security deposit return")[0].text, /DEPOSITS/);
  assert.ok(quoteInText("Residents accept the Premises AS-IS", high));
  assert.ok(quoteInText("A late charge of $150 applies ... plus $25 per day", high));
  assert.equal(quoteInText("tenant may break the lease for free", high), false);
  assert.ok(splitPassages(clean).length >= 15);
});

test("occupancy screen", () => {
  assert.equal(checkOccupancy(2, 2).level, "none");
  assert.equal(checkOccupancy(4, 2).level, "low");
  assert.equal(checkOccupancy(7, 3).level, "medium");
  assert.equal(checkOccupancy(7, 2).level, "high");
  assert.equal(checkOccupancy(0, 3).level, "unknown");
  assert.ok(RULES.some((r) => r.id === "boulder_occupancy"));
});

test("routing policy: medium/high, unclear fields, or unfinished agents require an attorney", () => {
  const ex = (unclear: any[] = [], status = "finished") => ({ status, fields: {}, clauses: [], unclear }) as any;
  const rk = (rating: any, status = "finished") => ({ status, rating, reasoning: "", flags: [], occupancy: null, rules_checked: [] }) as any;
  assert.equal(attorneyRequired(ex(), rk("low")), null);
  assert.match(attorneyRequired(ex(), rk("medium"))!, /medium/);
  assert.match(attorneyRequired(ex(), rk("high"))!, /high/);
  assert.match(attorneyRequired(ex([{ field: "bedrooms", reason: "?" }]), rk("low"))!, /unclear/);
  assert.match(attorneyRequired(ex(), rk(null, "needs_human_review"))!, /did not finish/);
});

test("sample slots", () => {
  assert.equal(toSlot("2026-11-05T13:00").label, "Thu, Nov 5 · 1:00 PM MT");
  assert.equal(nowInZone(new Date("2026-11-04T20:00:00Z")), "2026-11-04T13:00");
  assert.ok(futureSlotIds(new Date("2026-11-04T20:00:00Z")).every((s) => s > "2026-11-05T01:00"));
});
