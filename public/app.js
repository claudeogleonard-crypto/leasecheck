import { renderResults } from "/render.js";

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
    // Text files go into the paste box so the student can see them.
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
    startReview(data.id);
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Review my lease";
  }
});

// Review view and polling
let pollTimer = null;
let rendered = false;

function startReview(id) {
  $("#submit-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");
  rendered = false;
  window.scrollTo(0, 0);
  poll(id, 0);
}

async function poll(id, attempt) {
  clearTimeout(pollTimer);
  try {
    const res = await fetch(`/api/reviews/${id}`, { cache: "no-store" });
    if (res.status === 404) return showReviewError("We couldn't find that review. It may have been removed.");
    if (!res.ok) throw new Error();
    const r = await res.json();
    update(r);
    const finished = r.status === "failed" || r.status === "complete" || (r.status === "reviewed" && r.steps.automation.status === "failed");
    if (finished) return;
  } catch {
    // Network error: keep polling with backoff.
  }
  if (attempt > 300) return showReviewError("This is taking longer than expected. Refresh the page to check again.");
  pollTimer = setTimeout(() => poll(id, attempt + 1), attempt < 30 ? 2000 : 5000);
}

function update(r) {
  for (const li of document.querySelectorAll(".steps li")) {
    const s = r.steps[li.dataset.step]?.status || "pending";
    li.dataset.s = s;
    const dot = li.querySelector(".dot");
    if (!dot.dataset.n) dot.dataset.n = dot.textContent; // remember the step number
    dot.textContent = s === "done" ? "✓" : s === "failed" ? "!" : s === "running" ? "" : dot.dataset.n;
  }
  if (r.status === "failed") {
    $("#review-title").textContent = "We couldn't finish this review";
    showReviewError(r.error || "Something went wrong. Please try again.");
    return;
  }
  if (r.triage && (!rendered || r.automation)) {
    $("#review-title").textContent = "Your lease review";
    $("#review-sub").textContent = `Reviewed ${new Date(r.createdAt).toLocaleString()}. Bookmark this page to come back to it.`;
    const results = $("#results");
    results.replaceChildren(renderResults(r));
    rendered = true;
    if (r.automation) $("#progress").classList.add("hidden");
  }
}

function showReviewError(msg) {
  const e = $("#review-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

// Deep link: /?review=<id>
const existing = new URLSearchParams(location.search).get("review");
if (existing) startReview(existing);
window.addEventListener("popstate", () => location.reload());
