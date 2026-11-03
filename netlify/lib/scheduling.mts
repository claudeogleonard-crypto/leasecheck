// Suggests the next open attorney appointment slot.
// Attorney consult hours: Tuesday and Thursday afternoons, Mountain Time.
import { appointmentsStore, now, type Slot } from "./store.mts";

export const OFFICE_HOURS = {
  timeZone: "America/Denver",
  weekdays: [2, 4], // 0=Sun ... 2=Tue, 4=Thu
  times: ["13:00", "13:45", "14:30", "15:15"],
  durationMinutes: 40,
  location: "CU Boulder Student Legal Services (UMC) or Zoom",
  searchDays: 28,
};

/** Today's date (YYYY-MM-DD) in the office's time zone. */
export function todayInZone(date = new Date(), timeZone = OFFICE_HOURS.timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Candidate slots, starting the day after `fromDate`, in order. */
export function candidateSlots(fromDate: string, hours = OFFICE_HOURS): Slot[] {
  const [y, m, d] = fromDate.split("-").map(Number);
  const out: Slot[] = [];
  for (let i = 1; i <= hours.searchDays; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)); // calendar math only, so UTC is safe
    if (!hours.weekdays.includes(day.getUTCDay())) continue;
    const ymd = day.toISOString().slice(0, 10);
    const dayLabel = day.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
    for (const t of hours.times) {
      const [hh, mm] = t.split(":").map(Number);
      const h12 = ((hh + 11) % 12) + 1;
      const label = `${dayLabel} · ${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"} MT`;
      out.push({ id: `${ymd}T${t}`, label, durationMinutes: hours.durationMinutes, location: hours.location });
    }
  }
  return out;
}

/**
 * Atomically places a hold on the first free slot for this review.
 * `onlyIfNew` makes the claim safe if two reviews finish at the same time.
 */
export async function holdNextSlot(reviewId: string, urgent: boolean): Promise<Slot | null> {
  const store = appointmentsStore();
  // Non-urgent cases skip the first available day, leaving the earliest slots for urgent cases.
  const slots = candidateSlots(todayInZone());
  const firstDay = slots[0]?.id.slice(0, 10);
  const ordered = urgent ? slots : [...slots.filter((s) => !s.id.startsWith(firstDay)), ...slots.filter((s) => s.id.startsWith(firstDay))];
  for (const slot of ordered) {
    const { modified } = await store.setJSON(slot.id, { reviewId, status: "held", heldAt: now(), slot }, { onlyIfNew: true });
    if (modified) return slot;
  }
  return null;
}
