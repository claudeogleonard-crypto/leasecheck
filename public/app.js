import { AGENTS, el, renderResults, renderTimeline, statusText, stepItem } from "/render.js";

const $ = (s) => document.querySelector(s);
const MAX_PDF = 4 * 1024 * 1024;
let mode = "paste";
let pdf = null; // { base64, name }

// Tabs
for (const [btn, m] of [[$("#tab-paste"), "paste"], [$("#tab-upload"), "upload"]]) {
  btn.addEventListener("click", () => {
    mode = m;
    $("#tab-paste").setAttribute("aria-selected", m === "paste");
    $("#tab-upload").setAttribute("aria-selected", m === "upload");
    $("#panel-paste").classList.toggle("hidden", m !== "paste");
    $("#panel-upload").classList.toggle("hidden", m !== "upload");
  });
}

// Samples
document.querySelectorAll("[data-sample]").forEach((b) =>
  b.addEventListener("click", async () => {
    const res = await fetch(`/samples/${b.dataset.sample}`);
    $("#lease-text").value = await res.text();
    $("#lease-text").focus();
  })
);

// File upload
const dz = $("#dropzone");
const fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => fileInput.files[0] && handleFile(fileInput.files[0]));

async function handleFile(file) {
  showFormError("");
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    if (file.size > MAX_PDF) return showFormError("That PDF is larger than 4 MB. Try pasting the text instead.");
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    pdf = { base64: String(dataUrl).split(",")[1], name: file.name };
    $("#file-name").textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  } else if (file.type.startsWith("text/") || file.name.toLowerCase().endsWith(".txt")) {
    $("#lease-text").value = await file.text();
    pdf = null;
    $("#tab-paste").click();
  } else {
    showFormError("Please upload a PDF or .txt file.");
  }
}

function showFormError(msg) {
  const e = $("#form-error");
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

$("#lease-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showFormError("");
  const text = $("#lease-text").value.trim();
  if (mode === "upload" && !pdf) return showFormError("Choose a PDF to upload.");
  if (mode === "paste" && text.length < 200) return showFormError("Paste the full lease text (it looks too short).");
  if (!$("#consent").checked) return showFormError("Please confirm you understand this isn't legal advice.");

  const payload = {
    studentName: $("#student-name").value,
    studentEmail: $("#student-email").value,
    bedrooms: $("#bedrooms").value,
    notes: $("#notes").value,
    ...(mode === "upload" ? { pdfBase64: pdf.base64, fileName: pdf.name } : { text }),
  };

  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    const res = await fetch("/api/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error("Too many submissions. Please wait a minute and try again.");
    if (!res.ok) throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
    history.pushState({}, "", `/?review=${data.id}`);
    openReview(data.id);
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Review my lease";
  }
});

// ---------- Review: poll the background run and show each agent's steps live ----------

const POLL_MS = 1500;
const STALL_MS = 3 * 60_000; // no progress for this long = stalled
let pollTimer = null;
let shown = {}; // agent -> number of steps already in the timeline

const agentBox = (key) => document.querySelector(`.tl-agent[data-agent="${key}"]`);

function setAgentState(key, state, trace) {
  const box = agentBox(key);
  box.dataset.s = state;
  box.querySelector(".tl-status").textContent = statusText(state, trace);
}

function showAgentError(key, message, retry) {
  const box = agentBox(key).querySelector(".tl-error");
  box.replaceChildren(el("span", {}, message, " "), retry ? el("button", { class: "btn small", type: "button", onclick: retry }, "Try again") : "");
  box.classList.remove("hidden");
}

async function fetchRecord(id) {
  const res = await fetch(`/api/reviews/${id}`, { cache: "no-store" });
  if (res.status === 404) throw Object.assign(new Error("We couldn't find that review."), { fatal: true });
  if (!res.ok) throw new Error(`Couldn't load the review (HTTP ${res.status}).`);
  return res.json();
}

async function openReview(id) {
  $("#submit-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");
  $("#review-error").classList.add("hidden");
  $("#results").replaceChildren();
  window.scrollTo(0, 0);
  shown = {};
  let r;
  try {
    r = await fetchRecord(id);
  } catch (e) {
    return showReviewError(e.message);
  }
  renderTimeline($("#timeline"), r);
  for (const a of AGENTS) shown[a.key] = (r.traces[a.key] || []).length;
  poll(id, r, 0);
}

function poll(id, r, failures) {
  clearTimeout(pollTimer);
  if (r) {
    update(r);
    if (r.status === "complete") return;
    if (r.status === "failed") return showFailure(id, r);
    if (Date.now() - Date.parse(r.updatedAt) > STALL_MS) {
      return showFailure(id, { ...r, error: "This review stopped making progress." });
    }
  }
  pollTimer = setTimeout(async () => {
    try {
      poll(id, await fetchRecord(id), 0);
    } catch (e) {
      if (e.fatal || failures >= 10) return showReviewError(e.fatal ? e.message : "Lost connection to the server. Refresh the page to check again.");
      poll(id, null, failures + 1); // brief network blip: keep trying
    }
  }, POLL_MS);
}

/** Appends only the new steps since the last poll, so the timeline grows live. */
function update(r) {
  for (const a of AGENTS) {
    const trace = r.traces[a.key] || [];
    const list = agentBox(a.key).querySelector(".tl-steps");
    if (trace.length < (shown[a.key] || 0)) { list.replaceChildren(); shown[a.key] = 0; } // agent restarted on retry
    for (const s of trace.slice(shown[a.key] || 0)) list.append(stepItem(s));
    shown[a.key] = trace.length;
    setAgentState(a.key, r.steps[a.key].status, trace);
  }
  setAgentState("automation", r.steps.automation.status);
  if (r.triage) showResults(r);
}

function showFailure(id, r) {
  const where = [...AGENTS.map((a) => a.key), "automation"].find((k) => r.steps[k].status === "failed" || r.steps[k].status === "running") || "extraction";
  if (r.steps[where].status === "running") setAgentState(where, "failed");
  showAgentError(where, r.error || r.steps[where].error || "Something went wrong.", () => retry(id));
}

async function retry(id) {
  document.querySelectorAll(".tl-error").forEach((x) => x.classList.add("hidden"));
  try {
    const res = await fetch(`/api/reviews/${id}/retry`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(data.error || `Retry failed (HTTP ${res.status}).`);
    poll(id, await fetchRecord(id), 0);
  } catch (e) {
    showReviewError(e.message);
  }
}

function showResults(r) {
  $("#review-title").textContent = r.status === "complete" ? "Your lease review" : "Reviewing your lease…";
  $("#review-sub").textContent = `Started ${new Date(r.createdAt).toLocaleString()}. Bookmark this page to come back to it.`;
  $("#results").replaceChildren(renderResults(r));
}

function showReviewError(msg) {
  const e = $("#review-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

// Deep link: /?review=<id>
const existing = new URLSearchParams(location.search).get("review");
if (existing) openReview(existing);
window.addEventListener("popstate", () => location.reload());
