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

export const money = (n) => (typeof n === "number" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "Not stated");
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
export const riskBadge = (risk) => el("span", { class: `badge ${risk || "neutral"}` }, risk ? `${risk} risk` : "pending");

export function renderResults(r, { staff = false } = {}) {
  const { extraction: x, risk, triage: t, automation: a } = r;
  const frag = document.createDocumentFragment();
  if (!risk || !t) return frag;

  // Verdict
  frag.append(
    el("section", { class: `card verdict ${risk.overall_risk}` },
      el("div", { class: "score" }, String(risk.risk_score), el("small", {}, " /100")),
      el("div", {},
        riskBadge(risk.overall_risk),
        el("div", { style: "margin-top:6px;font-weight:600" },
          t.attorney_review_needed ? "Attorney review recommended" : "Attorney review not required"),
        el("div", { class: "muted", style: "font-size:14px" }, risk.rationale)
      )
    )
  );

  // Automation outcome
  if (a) {
    const box = el("section", { class: "card" }, el("h2", {}, a.queued ? "Next step: attorney review" : "What happens next"));
    if (a.queued) {
      box.append(
        el("p", {}, "We added your lease to the CU Boulder Student Legal Services attorney queue. Off-Campus Housing staff will contact you to confirm a time."),
        a.suggestedSlot
          ? el("p", {}, el("b", {}, "Suggested appointment: "), a.suggestedSlot.label, el("span", { class: "muted" }, ` (${a.suggestedSlot.durationMinutes} min · ${a.suggestedSlot.location})`))
          : el("p", { class: "muted" }, "No open slot in the next 4 weeks. Staff will reach out to schedule.")
      );
    } else {
      box.append(el("p", {}, "No attorney review appears necessary. Go through the questions below with your landlord before you sign."));
    }
    if (staff) {
      box.append(el("details", {}, el("summary", {}, "Automation log"),
        el("ul", { class: "plain" },
          el("li", {}, `Record saved: ${fmtDate(a.savedAt)}`),
          el("li", {}, `Queued: ${a.queued ? `yes (${a.queueReason})` : "no"}`),
          ...a.notifications.map((n) => el("li", {}, `${n.kind} → ${n.to}: ${n.result}`)),
          el("li", {}, `Completed: ${fmtDate(a.completedAt)}`)
        )));
    }
    frag.append(box);
  }

  // Summary
  frag.append(el("section", { class: "card" }, el("h2", {}, "Plain-language summary"), el("p", { style: "margin:0" }, t.plain_language_summary)));

  // Key numbers
  frag.append(
    el("section", { class: "card" }, el("h2", {}, "Key numbers"),
      el("dl", { class: "kv" }, ...t.key_numbers.map((k) => el("div", {}, el("dt", {}, k.label), el("dd", {}, k.value)))))
  );

  // Flags
  const flags = el("section", { class: "card" }, el("h2", {}, `Flagged clauses (${risk.flags.length})`));
  if (!risk.flags.length) flags.append(el("p", { class: "muted" }, "No risky clauses were flagged."));
  for (const f of risk.flags) {
    flags.append(
      el("div", { class: "flag" },
        el("div", { class: "flag-head" }, el("span", { class: `badge ${f.severity}` }, f.severity), el("b", {}, f.title)),
        el("div", {}, f.explanation),
        f.quote ? el("blockquote", {}, `“${f.quote}”`) : null,
        f.legal_note ? el("div", { class: "legal" }, f.legal_note) : null
      )
    );
  }
  frag.append(flags);

  // Occupancy
  const o = risk.occupancy;
  frag.append(
    el("section", { class: "card" },
      el("div", { class: "row" }, el("h2", { style: "margin:0" }, "Boulder occupancy check"), el("span", { class: `badge ${o.concern_level === "none" ? "low" : o.concern_level}` }, o.concern_level === "none" ? "no concern" : `${o.concern_level} concern`)),
      el("p", { class: "muted", style: "margin:8px 0" }, `Tenants on lease: ${o.tenants_on_lease ?? "not stated"} · Bedrooms: ${o.bedrooms ?? "not stated"}`),
      el("p", { style: "margin:0" }, o.notes)
    )
  );

  // Questions
  const qText = t.questions_for_landlord.map((q, i) => `${i + 1}. ${q}`).join("\n");
  frag.append(
    el("section", { class: "card" }, el("h2", {}, "Questions to ask your landlord"),
      el("ol", { class: "qs" }, ...t.questions_for_landlord.map((q) => el("li", {}, q))),
      el("div", { class: "copy-row" },
        el("button", {
          class: "btn small", type: "button",
          onclick: async (e) => { try { await navigator.clipboard.writeText(qText); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; } },
        }, "Copy questions")))
  );

  // Next steps
  frag.append(el("section", { class: "card" }, el("h2", {}, "Next steps"), el("ul", { class: "plain" }, ...t.next_steps.map((s) => el("li", {}, s)))));

  // Extracted details
  if (x) {
    const fees = x.fees.length
      ? el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "Fee"), el("th", {}, "Amount"), el("th", {}, "Frequency"), el("th", {}, "Refundable"))),
          el("tbody", {}, ...x.fees.map((f) => el("tr", {}, el("td", {}, f.name), el("td", {}, money(f.amount)), el("td", {}, f.frequency.replace("_", " ")), el("td", {}, f.refundable === null ? "—" : f.refundable ? "Yes" : "No"))))))
      : el("p", { class: "muted" }, "No additional fees found.");
    frag.append(
      el("section", { class: "card" },
        el("h2", {}, "What the lease says"),
        el("dl", { class: "kv" },
          ...[
            ["Address", x.property_address || "Not stated"],
            ["Landlord / manager", x.landlord_or_manager || "Not stated"],
            ["Monthly rent (total)", money(x.monthly_rent_total)],
            ["Rent per tenant", money(x.rent_per_tenant)],
            ["Security deposit", money(x.security_deposit)],
            ["Lease term", x.lease_length_months ? `${x.lease_length_months} months` : "Not stated"],
            ["Dates", [x.lease_start, x.lease_end].filter(Boolean).join(" → ") || "Not stated"],
            ["Tenants", x.number_of_tenants ?? "Not stated"],
            ["Liability", x.liability_type.replaceAll("_", " ")],
          ].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))
        ),
        el("h3", { style: "margin-top:16px" }, "Fees"), fees,
        el("details", {}, el("summary", {}, `Key clauses (${x.key_clauses.length})`),
          ...x.key_clauses.map((c) => el("div", { class: "flag" }, el("b", {}, c.title), el("div", {}, c.summary), c.quote ? el("blockquote", {}, `“${c.quote}”`) : null))),
        x.missing_or_unclear.length
          ? el("details", {}, el("summary", {}, `Missing or unclear (${x.missing_or_unclear.length})`), el("ul", { class: "plain" }, ...x.missing_or_unclear.map((m) => el("li", {}, m))))
          : null
      )
    );
  }

  if (staff) {
    frag.append(el("section", { class: "card" }, el("h2", {}, "Triage reasoning (staff)"), el("p", {}, `Urgency: ${t.urgency}`), el("p", { style: "margin:0" }, t.triage_reason)));
  }
  return frag;
}
