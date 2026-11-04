// Persistence on Netlify Blobs. Site-wide stores with strong consistency so the UI sees fresh state.
// Note: site-wide stores are shared by deploy previews and production. Avoid test submissions on previews.
import { getStore } from "@netlify/blobs";
import type { TraceStep } from "./agent-loop.mts";

const store = (name: string) => getStore({ name, consistency: "strong" });

export const reviewsStore = () => store("reviews");
export const inputsStore = () => store("lease-inputs");
export const queueStore = () => store("attorney-queue");
export const appointmentsStore = () => store("appointments");
export const notificationsStore = () => store("notifications");
export const locksStore = () => store("run-locks");

export type AgentName = "extraction" | "risk" | "triage";
export type StepName = AgentName | "automation";
export type StepStatus = "pending" | "running" | "done" | "failed";
export type Rating = "low" | "medium" | "high";
export type AgentStatus = "finished" | "needs_human_review";

export interface LeaseInput {
  text: string;
  fileName: string | null;
  studentNotes: string;
}

export interface Field {
  value: string;
  source_quote: string;
}

export interface ExtractionResult {
  status: AgentStatus;
  fields: Record<string, Field>;
  clauses: Field[];
  unclear: { field: string; reason: string }[];
}

export interface Flag {
  severity: Rating;
  clause_quote: string;
  reason: string;
  rule_id: string;
  rule_title: string | null;
}

export interface OccupancyCheck {
  tenants: number | null;
  bedrooms: number | null;
  people_per_bedroom: number | null;
  level: "none" | "low" | "medium" | "high" | "unknown";
  note: string;
}

export interface RiskResult {
  status: AgentStatus;
  rating: Rating | null; // null = agent didn't finish; treated as needing review
  reasoning: string;
  flags: Flag[];
  occupancy: OccupancyCheck | null;
  rules_checked: string[];
}

export interface TriageResult {
  status: AgentStatus;
  route: "summary_only" | "attorney_review";
  route_reason: string;
  student_summary: string;
  landlord_questions: string[];
  policy_override: string | null;
}

export interface Slot {
  id: string; // e.g. 2026-11-05T13:00 (America/Denver local time)
  label: string; // e.g. Thu, Nov 5 · 1:00 PM MT
  durationMinutes: number;
  location: string;
}

export interface ReviewRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "queued" | "running" | "reviewed" | "complete" | "failed";
  attempt: number; // increments on each retry; the background run only acts on the current attempt
  steps: Record<StepName, { status: StepStatus; startedAt?: string; finishedAt?: string; error?: string }>;
  input: {
    source: "text" | "pdf";
    fileName: string | null;
    sizeChars: number;
    studentName: string | null;
    studentEmail: string | null;
    bedrooms: number | null;
    notes: string | null;
  };
  traces: Partial<Record<AgentName, TraceStep[]>>;
  extraction?: ExtractionResult;
  risk?: RiskResult;
  triage?: TriageResult;
  automation?: {
    savedAt: string;
    queued: boolean;
    queueReason: string | null;
    suggestedSlot: Slot | null;
    notifications: { kind: string; to: string; result: string }[];
    completedAt: string;
  };
  error?: string;
}

export interface QueueItem {
  id: string; // same as review id
  createdAt: string;
  updatedAt: string;
  priority: 1 | 2 | 3; // 1 = most urgent
  risk: Rating | "needs_review";
  reason: string;
  studentName: string | null;
  studentEmail: string | null;
  address: string | null;
  monthlyRent: string | null;
  topFlags: { severity: Rating; title: string }[];
  suggestedSlot: Slot | null;
  status: "new" | "scheduled" | "in_review" | "resolved";
  staffNotes: string;
}

export interface NotificationRecord {
  id: string;
  createdAt: string;
  reviewId: string;
  kind: "staff_attorney_queue" | "student_review_ready";
  to: string;
  subject: string;
  body: string;
  delivery: { email: string; webhook: string };
}

export const now = () => new Date().toISOString();

export async function getReview(id: string) {
  return (await reviewsStore().get(id, { type: "json" })) as ReviewRecord | null;
}

export async function saveReview(r: ReviewRecord) {
  r.updatedAt = now();
  await reviewsStore().setJSON(r.id, r);
  return r;
}

export async function getLeaseInput(id: string) {
  return (await inputsStore().get(id, { type: "json" })) as LeaseInput | null;
}

export async function listJSON<T>(name: string, limit = 200): Promise<T[]> {
  const s = store(name);
  const { blobs } = await s.list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const items = await Promise.all(keys.map((k) => s.get(k, { type: "json" })));
  return items.filter(Boolean) as T[];
}
