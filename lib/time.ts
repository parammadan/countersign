// One time zone everywhere the firm reads times (the same one used for dates written into agreements),
// always labelled. Audit trails and certificates use UTC, also labelled.
export const APP_TZ = process.env.APP_TZ || "America/New_York";

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: APP_TZ, timeZoneName: "short" });
}

export function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: APP_TZ });
}
