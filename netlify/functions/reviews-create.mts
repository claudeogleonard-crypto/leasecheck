// POST /api/reviews: accepts a lease (pasted text or PDF, converted to text), stores it, and returns the review id.
import type { Config, Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { error, json } from "../lib/http.mts";
import { inputsStore, now, saveReview, type ReviewRecord } from "../lib/store.mts";

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // keeps the base64 request under Netlify's 6 MB payload limit
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function pdfToText(base64: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")));
  const { text } = await extractText(pdf, { mergePages: false });
  // Keep page breaks as blank lines so the lease splits into passages.
  return (Array.isArray(text) ? text : [text]).join("\n\n").trim();
}

export default async (req: Request, _context: Context) => {
  if (!process.env.ANTHROPIC_API_KEY) return error("Server is missing ANTHROPIC_API_KEY.", 503);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return error("Request body must be JSON.");
  }

  let text = typeof body.text === "string" ? body.text.trim() : "";
  const pdfBase64 = typeof body.pdfBase64 === "string" ? body.pdfBase64.replace(/^data:.*?;base64,/, "").replace(/\s/g, "") : "";
  if (!text && !pdfBase64) return error("Paste the lease text or upload a PDF.");
  if (text && text.length < 200) return error("That text is too short to be a lease. Paste the full lease.");
  if (text.length > MAX_TEXT_CHARS) return error(`Lease text is too long (max ${MAX_TEXT_CHARS.toLocaleString()} characters).`);
  if (pdfBase64) {
    const bytes = Math.floor((pdfBase64.length * 3) / 4);
    if (bytes > MAX_PDF_BYTES) return error("PDF is too large (max 4 MB). Try pasting the text instead.");
    if (!pdfBase64.startsWith("JVBER")) return error("That file doesn't look like a PDF.");
    try {
      text = await pdfToText(pdfBase64);
    } catch {
      return error("We couldn't read that PDF. Try pasting the lease text instead.");
    }
    if (text.length < 200) return error("This PDF has no readable text (it may be a scanned image). Please paste the lease text instead.");
  }

  const studentEmail = typeof body.studentEmail === "string" ? body.studentEmail.trim().slice(0, 200) : "";
  if (studentEmail && !EMAIL_RE.test(studentEmail)) return error("Enter a valid email address (or leave it blank).");
  const bedroomsNum = Number(body.bedrooms);
  const bedrooms = Number.isInteger(bedroomsNum) && bedroomsNum > 0 && bedroomsNum < 30 ? bedroomsNum : null;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;

  const id = randomUUID();
  const studentNotes = [bedrooms ? `The unit has ${bedrooms} bedroom(s).` : "", notes].filter(Boolean).join("\n");
  await inputsStore().setJSON(id, { text, fileName, studentNotes });

  const record: ReviewRecord = {
    id,
    createdAt: now(),
    updatedAt: now(),
    status: "created",
    steps: {
      extraction: { status: "pending" },
      risk: { status: "pending" },
      triage: { status: "pending" },
      automation: { status: "pending" },
    },
    input: {
      source: pdfBase64 ? "pdf" : "text",
      fileName,
      sizeChars: text.length,
      studentName: typeof body.studentName === "string" ? body.studentName.trim().slice(0, 100) || null : null,
      studentEmail: studentEmail || null,
      bedrooms,
      notes: notes || null,
    },
    traces: {},
  };
  await saveReview(record);
  // The browser now runs the three agents in order: /api/agents/extraction, /risk, /triage.
  return json({ id }, 201);
};

export const config: Config = {
  path: "/api/reviews",
  method: "POST",
  // Protects the API budget: at most 10 submissions per minute per IP.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
