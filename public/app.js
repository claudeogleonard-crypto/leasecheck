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

// ---------- Review: run the three agents in order, streaming each one's steps ----------

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
  if (res.status === 404) throw new Error("We couldn't find that review.");
  if (!res.ok) throw new Error(`Couldn't load the review (HTTP ${res.status}).`);
  return res.json();
}

/** Runs one agent function and streams its NDJSON steps into the timeline. Resolves with the saved record. */
async function runAgentStream(id, key) {
  setAgentState(key, "running");
  const list = agentBox(key).querySelector(".tl-steps");
  list.replaceChildren();
  agentBox(key).querySelector(".tl-error").classList.add("hidden");
  const trace = [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000); // the function itself stops by ~60s
  let res;
  try {
    res = await fetch(`/api/agents/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }), signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === "AbortError" ? "The agent took too long to respond." : "Network error. Check your connection.");
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `The agent request failed (HTTP ${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "step") {
          trace.push(ev.step);
          list.append(stepItem(ev.step));
          setAgentState(key, "running", trace);
        } else if (ev.type === "done") final = ev.record;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "The agent took too long to respond." : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!final) throw new Error("The agent stopped before finishing. Please try again.");
  setAgentState(key, "done", trace);
  return final;
}

async function openReview(id) {
  $("#submit-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");
  $("#review-error").classList.add("hidden");
  $("#results").replaceChildren();
  window.scrollTo(0, 0);
  let r;
  try {
    r = await fetchRecord(id);
  } catch (e) {
    return showReviewError(e.message);
  }
  renderTimeline($("#timeline"), r);
  if (r.triage) showResults(r);
  await continueReview(id, r);
}

async function continueReview(id, r) {
  for (const a of AGENTS) {
    const st = r.steps[a.key].status;
    if (st === "done") continue;
    if (st === "failed" || (st === "running" && r.steps[a.key].startedAt && Date.now() - Date.parse(r.steps[a.key].startedAt) > 70_000)) {
      // Don't silently re-spend on reload: offer a retry.
      setAgentState(a.key, "failed");
      return showAgentError(a.key, r.steps[a.key].error || "This step didn't finish.", () => retryFrom(id));
    }
    try {
      r = await runAgentStream(id, a.key);
    } catch (e) {
      setAgentState(a.key, "failed");
      return showAgentError(a.key, e.message, () => retryFrom(id));
    }
  }
  showResults(r);
  await waitForAutomation(id);
}

async function retryFrom(id) {
  document.querySelectorAll(".tl-error").forEach((x) => x.classList.add("hidden"));
  try {
    const r = await fetchRecord(id);
    for (const a of AGENTS) if (r.steps[a.key].status !== "done") r.steps[a.key].status = "pending";
    await continueReview(id, r);
  } catch (e) {
    showReviewError(e.message);
  }
}

async function waitForAutomation(id) {
  setAgentState("automation", "running");
  for (let i = 0; i < 30; i++) {
    let r;
    try { r = await fetchRecord(id); } catch { r = null; }
    if (r?.automation) {
      setAgentState("automation", "done");
      return showResults(r);
    }
    if (r?.steps.automation.status === "failed") break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  setAgentState("automation", "failed");
  showAgentError("automation", "Your review is complete, but the follow-up step (queueing and notifications) didn't confirm. Off-Campus Housing staff can still see your review.");
}

function showResults(r) {
  $("#review-title").textContent = "Your lease review";
  $("#review-sub").textContent = `Reviewed ${new Date(r.createdAt).toLocaleString()}. Bookmark this page to come back to it.`;
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
