// Shared rendering helpers for the student page and the staff dashboard.
// All model output is treated as untrusted and inserted as text, never as HTML.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
export const riskBadge = (risk) =>
  el("span", { class: `badge ${risk === "needs_review" ? "medium" : risk || "neutral"}` }, risk === "needs_review" ? "needs review" : risk ? `${risk} risk` : "pending");

export const AGENTS = [
  { key: "extraction", name: "Extraction agent", goal: "Searches the lease and records rent, deposit, fees, term, tenants, bedrooms and key clauses, each with a quote" },
  { key: "risk", name: "Risk agent", goal: "Picks which rules to check, screens occupancy, flags risky clauses and rates the lease" },
  { key: "triage", name: "Triage agent", goal: "Reviews the flags, chooses a route, and writes your summary and landlord questions" },
];

const FIELD_LABELS = {
  monthly_rent: "Monthly rent", rent_per_tenant: "Rent per tenant", security_deposit: "Security deposit", fees: "Fees",
  lease_start: "Start", lease_end: "End", lease_length: "Lease length", number_of_tenants: "Tenants", bedrooms: "Bedrooms",
  property_address: "Address", landlord: "Landlord", liability: "Liability",
};
const label = (f) => FIELD_LABELS[f] || f.replaceAll("_", " ");
const cut = (s, n = 90) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");

/** One timeline line, e.g. "looked up rule: Security deposit return". */
export function describeStep(s) {
  if (s.kind === "note") return { icon: "💬", text: cut(s.result, 160), cls: "note" };
  if (s.kind === "system") return { icon: "⚠", text: s.result, cls: "warn" };
  const i = s.input || {};
  const firstLine = (s.result || "").split("\n")[0];
  let text;
  switch (s.tool) {
    case "search_lease": text = `searched lease: "${i.query}"${/^No passages/.test(s.result) ? " → no match" : ` → found ${(s.result.match(/\[P\d+\]/g) || []).join(" ")}`}`; break;
    case "record_field": text = `recorded ${label(i.name)}: ${cut(i.value, 70)}`; break;
    case "flag_unclear": text = `flagged unclear: ${label(i.field)} (${cut(i.reason, 70)})`; break;
    case "finish_extraction": text = "finished extraction"; break;
    case "lookup_rule": text = `looked up rule: ${firstLine.split(":")[0]}`; break;
    case "check_occupancy": text = `checked occupancy: ${i.tenants || "?"} tenants / ${i.bedrooms || "?"} bedrooms → ${(s.result.match(/Level: (\w+)/) || [])[1] || ""}`; break;
    case "add_flag": text = `added ${i.severity} flag: ${cut(i.reason, 80)}`; break;
    case "set_risk_rating": text = `rated the lease ${i.rating}`; break;
    case "get_flags": text = "reviewed the flags and unclear fields"; break;
    case "get_attorney_availability": text = "checked attorney availability"; break;
    case "decide_route": text = `chose route: ${i.route === "attorney_review" ? "attorney review" : "summary only"}`; break;
    case "write_student_summary": text = "wrote the student summary"; break;
    case "draft_landlord_questions": text = `drafted ${(i.questions || []).length} landlord questions`; break;
    case "finish_triage": text = "finished triage"; break;
    default: text = s.tool;
  }
  if (s.isError) return { icon: "↺", text: `${text} → rejected: ${cut(s.result.replace(/^Error:\s*/, ""), 110)}`, cls: "retry" };
  const sev = s.tool === "add_flag" ? i.severity : s.tool === "set_risk_rating" ? i.rating : null;
  return { icon: "→", text, cls: sev ? `sev-${sev}` : "" };
}

export function stepItem(s) {
  const d = describeStep(s);
  return el("li", { class: `tl-step ${d.cls}` }, el("span", { class: "tl-icon", "aria-hidden": "true" }, d.icon), el("span", {}, d.text));
}

/** Builds (or rebuilds) the agent timeline from a record's saved traces. */
export function renderTimeline(container, r) {
  container.replaceChildren(
    ...AGENTS.map((a) => {
      const st = r?.steps?.[a.key]?.status || "pending";
      return el("section", { class: "tl-agent", "data-agent": a.key, "data-s": st },
        el("div", { class: "tl-head" },
          el("span", { class: "dot" }),
          el("div", {}, el("div", { class: "t" }, a.name), el("div", { class: "d" }, a.goal)),
          el("span", { class: "spacer" }),
          el("span", { class: "tl-status hint" }, statusText(st, r?.traces?.[a.key]))),
        el("ol", { class: "tl-steps" }, ...(r?.traces?.[a.key] || []).map(stepItem)),
        el("div", { class: "tl-error error hidden", role: "alert" }));
    }),
    el("section", { class: "tl-agent", "data-agent": "automation", "data-s": r?.steps?.automation?.status || "pending" },
      el("div", { class: "tl-head" }, el("span", { class: "dot" }),
        el("div", {}, el("div", { class: "t" }, "Follow-up automation"), el("div", { class: "d" }, "Saves the record, queues attorney reviews, attaches a suggested slot and sends notifications")),
        el("span", { class: "spacer" }), el("span", { class: "tl-status hint" }, statusText(r?.steps?.automation?.status))),
      el("div", { class: "tl-error error hidden", role: "alert" })),
  );
}

export function statusText(st, trace) {
  const tools = (trace || []).filter((s) => s.kind === "tool").length;
  if (st === "done") return tools ? `done · ${tools} tool calls` : "done";
  if (st === "running") return "working…";
  if (st === "failed") return "failed";
  return "waiting";
}

export function renderResults(r, { staff = false } = {}) {
  const { extraction: x, risk, triage: t, automation: a } = r;
  const frag = document.createDocumentFragment();
  if (!risk || !t || !x) return frag;
  const rating = risk.rating || "needs_review";
  const attorney = t.route === "attorney_review";

  frag.append(
    el("section", { class: `card verdict ${risk.rating || "medium"}` },
      el("div", {},
        riskBadge(rating),
        el("div", { style: "margin-top:6px;font-weight:700;font-size:18px" }, attorney ? "Route: attorney review" : "Route: summary only"),
        el("div", { class: "muted", style: "font-size:14px" }, risk.reasoning),
        t.policy_override ? el("div", { class: "hint", style: "margin-top:4px" }, t.policy_override) : null)));

  if (a) {
    const box = el("section", { class: "card" }, el("h2", {}, a.queued ? "Next step: attorney review" : "What happens next"));
    if (a.queued) {
      box.append(
        el("p", {}, "Your lease is in the CU Boulder Student Legal Services attorney queue. Off-Campus Housing staff will contact you to confirm a time."),
        a.suggestedSlot
          ? el("p", {}, el("b", {}, "Suggested appointment: "), a.suggestedSlot.label, el("span", { class: "muted" }, ` (${a.suggestedSlot.durationMinutes} min · ${a.suggestedSlot.location})`))
          : el("p", { class: "muted" }, "No open slot in the calendar right now. Staff will reach out to schedule."));
    } else {
      box.append(el("p", {}, "No attorney review needed. Go through the questions below with your landlord before you sign."));
    }
    if (staff) {
      box.append(el("details", {}, el("summary", {}, "Automation log"),
        el("ul", { class: "plain" },
          el("li", {}, `Record saved: ${fmtDate(a.savedAt)}`),
          el("li", {}, `Queued: ${a.queued ? `yes (${a.queueReason})` : "no"}`),
          ...a.notifications.map((n) => el("li", {}, `${n.kind} → ${n.to}: ${n.result}`)),
          el("li", {}, `Completed: ${fmtDate(a.completedAt)}`))));
    }
    frag.append(box);
  }

  frag.append(el("section", { class: "card" }, el("h2", {}, "Plain-language summary"), el("p", { style: "margin:0;white-space:pre-line" }, t.student_summary)));

  const keyFields = ["monthly_rent", "rent_per_tenant", "security_deposit", "fees", "lease_length", "number_of_tenants", "bedrooms", "property_address"];
  const unclear = new Map(x.unclear.map((u) => [u.field, u.reason]));
  frag.append(
    el("section", { class: "card" }, el("h2", {}, "What the lease says"),
      el("dl", { class: "kv" }, ...keyFields.filter((f) => x.fields[f] || unclear.has(f)).map((f) =>
        el("div", { title: x.fields[f]?.source_quote || unclear.get(f) || "" },
          el("dt", {}, label(f)),
          el("dd", {}, x.fields[f] ? x.fields[f].value : el("span", { class: "badge medium" }, "unclear"))))),
      x.unclear.length
        ? el("div", { style: "margin-top:12px" }, el("h3", {}, "Unclear or missing"), el("ul", { class: "plain" }, ...x.unclear.map((u) => el("li", {}, `${label(u.field)}: ${u.reason}`))))
        : null,
      x.clauses.length
        ? el("details", {}, el("summary", {}, `Notable clauses (${x.clauses.length})`), ...x.clauses.map((c) => el("div", { class: "flag" }, el("div", {}, c.value), el("blockquote", {}, `“${c.source_quote}”`))))
        : null));

  const flags = el("section", { class: "card" }, el("h2", {}, `Flagged clauses (${risk.flags.length})`));
  if (!risk.flags.length) flags.append(el("p", { class: "muted" }, "No risky clauses were flagged."));
  const order = { high: 0, medium: 1, low: 2 };
  for (const f of [...risk.flags].sort((p, q) => order[p.severity] - order[q.severity])) {
    flags.append(el("div", { class: "flag" },
      el("div", { class: "flag-head" }, el("span", { class: `badge ${f.severity}` }, f.severity), f.rule_title ? el("span", { class: "hint" }, f.rule_title) : null),
      el("div", {}, f.reason),
      f.clause_quote ? el("blockquote", {}, `“${f.clause_quote}”`) : el("div", { class: "hint" }, "(Something the lease leaves out)")));
  }
  frag.append(flags);

  if (risk.occupancy) {
    const o = risk.occupancy;
    frag.append(el("section", { class: "card" },
      el("div", { class: "row" }, el("h2", { style: "margin:0" }, "Boulder occupancy check"),
        el("span", { class: `badge ${o.level === "none" ? "low" : o.level === "unknown" ? "neutral" : o.level}` }, o.level === "none" ? "no concern" : o.level === "unknown" ? "unknown" : `${o.level} concern`)),
      el("p", { style: "margin:8px 0 0" }, o.note)));
  }

  const qText = t.landlord_questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  frag.append(el("section", { class: "card" }, el("h2", {}, "Questions to ask your landlord"),
    el("ol", { class: "qs" }, ...t.landlord_questions.map((q) => el("li", {}, q))),
    el("div", { class: "copy-row" }, el("button", {
      class: "btn small", type: "button",
      onclick: async (e) => { try { await navigator.clipboard.writeText(qText); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; } },
    }, "Copy questions"))));

  if (staff) {
    frag.append(el("section", { class: "card" }, el("h2", {}, "Routing (staff)"), el("p", { style: "margin:0" }, t.route_reason),
      el("p", { class: "hint" }, `Rules checked: ${risk.rules_checked.join(", ") || "none"}`)));
  }
  return frag;
}
