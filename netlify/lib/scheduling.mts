// Attorney appointment slots come from data/attorney-slots.json (sample data).
// Holds are stored in Blobs; `onlyIfNew` makes a hold atomic if two reviews finish at once.
import slotData from "../../data/attorney-slots.json" with { type: "json" };
import { appointmentsStore, now, type Slot } from "./store.mts";

/** Current local date-time in the office time zone as "YYYY-MM-DDTHH:mm". */
export function nowInZone(date = new Date(), timeZone = slotData.timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function toSlot(id: string): Slot {
  const [ymd, t] = id.split("T");
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const dayLabel = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const label = `${dayLabel} · ${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"} MT`;
  return { id, label, durationMinutes: slotData.durationMinutes, location: slotData.location };
}

/** Future slots from the sample calendar, at least 12 hours out, in order. */
export function futureSlotIds(date = new Date()) {
  const cutoff = nowInZone(new Date(date.getTime() + 12 * 3600_000));
  return slotData.slots.filter((s) => s > cutoff).sort();
}

export async function openSlots(limit = 5): Promise<Slot[]> {
  const store = appointmentsStore();
  const { blobs } = await store.list();
  const taken = new Set(blobs.map((b) => b.key));
  return futureSlotIds().filter((s) => !taken.has(s)).slice(0, limit).map(toSlot);
}

/** Holds the first free slot. Non-urgent cases leave the earliest day for urgent ones. */
export async function holdNextSlot(reviewId: string, urgent: boolean): Promise<Slot | null> {
  const store = appointmentsStore();
  const ids = futureSlotIds();
  const firstDay = ids[0]?.slice(0, 10);
  const ordered = urgent ? ids : [...ids.filter((s) => !s.startsWith(firstDay)), ...ids.filter((s) => s.startsWith(firstDay))];
  for (const id of ordered) {
    const slot = toSlot(id);
    const { modified } = await store.setJSON(id, { reviewId, status: "held", heldAt: now(), slot }, { onlyIfNew: true });
    if (modified) return slot;
  }
  return null;
}
