// POST /api/reviews: accepts a lease (text or PDF), stores it, and starts the background agent pipeline.
import type { Config, Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { callInternal, error, json } from "../lib/http.mts";
import { inputsStore, now, saveReview, type ReviewRecord } from "../lib/store.mts";

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // keeps the base64 request under Netlify's 6 MB payload limit
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async (req: Request, _context: Context) => {
  if (!Netlify.env.get("ANTHROPIC_API_KEY")) return error("Server is missing ANTHROPIC_API_KEY.", 503);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return error("Request body must be JSON.");
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const pdfBase64 = typeof body.pdfBase64 === "string" ? body.pdfBase64.replace(/^data:.*?;base64,/, "").replace(/\s/g, "") : "";
  if (!text && !pdfBase64) return error("Paste the lease text or upload a PDF.");
  if (text && text.length < 200) return error("That text is too short to be a lease. Paste the full lease.");
  if (text.length > MAX_TEXT_CHARS) return error(`Lease text is too long (max ${MAX_TEXT_CHARS.toLocaleString()} characters).`);
  if (pdfBase64) {
    const bytes = Math.floor((pdfBase64.length * 3) / 4);
    if (bytes > MAX_PDF_BYTES) return error("PDF is too large (max 4 MB). Try pasting the text instead.");
    if (!pdfBase64.startsWith("JVBER")) return error("That file doesn't look like a PDF.");
  }

  const studentEmail = typeof body.studentEmail === "string" ? body.studentEmail.trim().slice(0, 200) : "";
  if (studentEmail && !EMAIL_RE.test(studentEmail)) return error("Enter a valid email address (or leave it blank).");
  const bedroomsNum = Number(body.bedrooms);
  const bedrooms = Number.isInteger(bedroomsNum) && bedroomsNum > 0 && bedroomsNum < 30 ? bedroomsNum : null;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;

  const id = randomUUID();
  const studentNotes = [bedrooms ? `The unit has ${bedrooms} bedroom(s).` : "", notes].filter(Boolean).join("\n");
  await inputsStore().setJSON(id, pdfBase64 ? { pdfBase64, fileName, studentNotes } : { text, fileName, studentNotes });

  const record: ReviewRecord = {
    id,
    createdAt: now(),
    updatedAt: now(),
    status: "queued",
    steps: {
      extraction: { status: "pending" },
      risk: { status: "pending" },
      triage: { status: "pending" },
      automation: { status: "pending" },
    },
    input: {
      source: pdfBase64 ? "pdf" : "text",
      fileName,
      sizeChars: pdfBase64 ? null : text.length,
      studentName: typeof body.studentName === "string" ? body.studentName.trim().slice(0, 100) || null : null,
      studentEmail: studentEmail || null,
      bedrooms,
      notes: notes || null,
    },
  };
  await saveReview(record);

  try {
    await callInternal(req, "/api/internal/pipeline", { id });
  } catch (e) {
    record.status = "failed";
    record.error = "Could not start the review. Please try again.";
    await saveReview(record);
    console.error(e);
    return error(record.error, 502);
  }
  return json({ id }, 202);
};

export const config: Config = {
  path: "/api/reviews",
  method: "POST",
  // Protects the API budget: at most 10 submissions per minute per IP.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
