import { el, fmtDate, money, renderResults, riskBadge } from "/render.js";

const $ = (s) => document.querySelector(s);
const KEY = "leasecheck-staff-key";
const STATUS_LABEL = { new: "New", scheduled: "Scheduled", in_review: "In review", resolved: "Resolved" };
let data = null;

const getKey = () => { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } };
const setKey = (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-staff-key": getKey(), ...(opts.headers || {}) } });
  if (res.status === 401) { setKey(""); showLogin("Incorrect password."); throw new Error("unauthorized"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showLogin(msg = "") {
  $("#dash").classList.add("hidden");
  $("#logout").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-error").textContent = msg;
  $("#login-error").classList.toggle("hidden", !msg);
  $("#pw").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setKey($("#pw").value);
  try { await load(); } catch (err) { if (err.message !== "unauthorized") showLogin(err.message); }
});
$("#logout").addEventListener("click", () => { setKey(""); showLogin(); });
$("#refresh").addEventListener("click", () => load());
$("#status-filter").addEventListener("change", () => renderQueue());

async function load() {
  data = await api("/api/staff/overview");
  $("#login").classList.add("hidden");
  $("#dash").classList.remove("hidden");
  $("#logout").classList.remove("hidden");
  $("#updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  renderStats();
  renderQueue();
  renderReviews();
  renderNotifications();
}

function renderStats() {
  const s = data.stats;
  const stat = (n, l) => el("div", { class: "stat" }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, l));
  $("#stats").replaceChildren(
    stat(s.openQueue, "Open in attorney queue"),
    stat(s.totalReviews, "Recent reviews"),
    stat(s.byRisk.high, "High risk"),
    stat(s.byRisk.medium, "Medium risk"),
    stat(s.byRisk.low, "Low risk"),
    stat(s.failed, "Failed reviews"),
  );
}

function renderQueue() {
  const f = $("#status-filter").value;
  const items = data.queue.filter((q) => f === "all" || (f === "open" ? q.status !== "resolved" : q.status === f));
  if (!items.length) return $("#queue").replaceChildren(el("p", { class: "muted" }, "Nothing here right now."));
  $("#queue").replaceChildren(...items.map(queueCard));
}

function queueCard(q) {
  const notes = el("textarea", { "aria-label": "Staff notes", placeholder: "Staff notes…" });
  notes.value = q.staffNotes || "";
  const status = el("select", { "aria-label": "Status", style: "width:auto" },
    ...Object.entries(STATUS_LABEL).map(([v, l]) => el("option", { value: v, selected: q.status === v }, l)));
  const msg = el("span", { class: "hint" });

  const save = async (extra = {}) => {
    msg.textContent = "Saving…";
    try {
      const updated = await api(`/api/staff/queue/${q.id}`, { method: "PATCH", body: JSON.stringify({ status: status.value, staffNotes: notes.value, ...extra }) });
      Object.assign(q, updated);
      msg.textContent = "Saved";
      renderQueue();
    } catch (e) { msg.textContent = `Error: ${e.message}`; }
  };

  return el("div", { class: `queue-item p${q.priority}` },
    el("div", { class: "row" },
      riskBadge(q.risk),
      el("span", { class: "badge neutral" }, q.urgency),
      el("b", {}, q.address || "Address not stated"),
      el("span", { class: "spacer" }),
      el("span", { class: "hint" }, `Added ${fmtDate(q.createdAt)}`)
    ),
    el("div", { style: "margin:8px 0" },
      el("div", {}, el("b", {}, "Student: "), q.studentName || "Anonymous", q.studentEmail ? " · " : "", q.studentEmail ? el("a", { href: `mailto:${q.studentEmail}` }, q.studentEmail) : ""),
      el("div", {}, el("b", {}, "Rent: "), money(q.monthlyRent), " · ", el("b", {}, "Score: "), `${q.riskScore}/100`),
      el("div", {}, el("b", {}, "Why: "), q.reason),
      el("div", {}, el("b", {}, "Top issues: "), q.topFlags.map((f) => f.title).join("; ") || "—"),
      el("div", {}, el("b", {}, "Suggested slot: "),
        q.suggestedSlot ? `${q.suggestedSlot.label} (${q.suggestedSlot.durationMinutes} min)` : "None available",
        q.status === "scheduled" ? el("span", { class: "badge low", style: "margin-left:8px" }, "confirmed") : "")
    ),
    notes,
    el("div", { class: "row", style: "margin-top:8px" },
      status,
      el("button", { class: "btn small", type: "button", onclick: () => save() }, "Save"),
      q.suggestedSlot && q.status === "new" ? el("button", { class: "btn small", type: "button", onclick: () => { status.value = "scheduled"; save({ confirmSlot: true }); } }, "Confirm slot") : null,
      q.suggestedSlot && q.status === "resolved" ? el("button", { class: "btn small", type: "button", onclick: () => save({ releaseSlot: true }) }, "Release slot") : null,
      el("button", { class: "btn small", type: "button", onclick: () => openReview(q.id) }, "View full review"),
      msg
    )
  );
}

function renderReviews() {
  if (!data.reviews.length) return $("#reviews").replaceChildren(el("tr", {}, el("td", { colspan: 7, class: "muted" }, "No reviews yet.")));
  $("#reviews").replaceChildren(...data.reviews.map((r) =>
    el("tr", {},
      el("td", {}, fmtDate(r.createdAt)),
      el("td", {}, r.studentName || "—"),
      el("td", {}, r.address || "—"),
      el("td", {}, r.risk ? riskBadge(r.risk) : "—"),
      el("td", {}, r.attorney === null ? "—" : r.attorney ? "Yes" : "No"),
      el("td", {}, r.status === "failed" ? el("span", { title: r.error || "" }, "failed") : r.status),
      el("td", {}, el("button", { class: "btn small", type: "button", onclick: () => openReview(r.id) }, "Open"))
    )
  ));
}

function renderNotifications() {
  if (!data.notifications.length) return $("#notifications").replaceChildren(el("tr", {}, el("td", { colspan: 5, class: "muted" }, "No notifications yet.")));
  $("#notifications").replaceChildren(...data.notifications.map((n) =>
    el("tr", {},
      el("td", {}, fmtDate(n.createdAt)),
      el("td", {}, n.kind === "staff_attorney_queue" ? "Staff alert" : "Student"),
      el("td", {}, n.to),
      el("td", {}, el("details", {}, el("summary", {}, n.subject), el("pre", { style: "white-space:pre-wrap;font-size:13px" }, n.body))),
      el("td", { class: "hint" }, `email: ${n.delivery.email}`, el("br"), `webhook: ${n.delivery.webhook}`)
    )
  ));
}

async function openReview(id) {
  $("#drawer-body").replaceChildren(el("p", { class: "muted" }, "Loading…"));
  $("#drawer").classList.remove("hidden");
  $("#drawer-backdrop").classList.remove("hidden");
  $("#drawer-close").focus();
  try {
    const r = await api(`/api/staff/reviews/${id}`);
    $("#drawer-title").textContent = r.extraction?.property_address || "Review";
    const meta = el("div", { class: "card" },
      el("div", {}, el("b", {}, "Submitted: "), fmtDate(r.createdAt), " · ", el("b", {}, "Source: "), r.input.source === "pdf" ? `PDF (${r.input.fileName || "upload"})` : "Pasted text"),
      el("div", {}, el("b", {}, "Student: "), r.input.studentName || "Anonymous", r.input.studentEmail ? ` · ${r.input.studentEmail}` : ""),
      r.input.notes ? el("div", {}, el("b", {}, "Student notes: "), r.input.notes) : null,
      el("div", {}, el("a", { href: `/?review=${r.id}`, target: "_blank", rel: "noopener" }, "Open student view ↗")),
      r.error ? el("div", { class: "error", style: "margin-top:8px" }, r.error) : null
    );
    $("#drawer-body").replaceChildren(meta, renderResults(r, { staff: true }));
  } catch (e) {
    $("#drawer-body").replaceChildren(el("p", { class: "error" }, e.message));
  }
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#drawer-backdrop").classList.add("hidden");
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

if (getKey()) load().catch((e) => { if (e.message !== "unauthorized") showLogin(e.message); });
else showLogin();
