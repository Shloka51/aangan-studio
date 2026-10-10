// Cal.com booking-link generation. Cal.com booking pages accept prefill query
// parameters (name, notes, and custom booking questions such as phone), so the
// caller lands on a form that already knows who they are.
export interface BookingLinkInput {
  name?: string;
  number?: string;
  notes: string;
}

export const DEMO_BOOKING_URL = "https://cal.com/aangan-studio/consultation";

export function calcomLink(input: BookingLinkInput, baseUrl = process.env.CALCOM_BOOKING_URL || DEMO_BOOKING_URL): string {
  const url = new URL(baseUrl);
  if (input.name) url.searchParams.set("name", input.name);
  if (input.number) url.searchParams.set("phone", input.number);
  url.searchParams.set("notes", input.notes);
  return url.toString();
}

export const isCalcomLive = () => Boolean(process.env.CALCOM_BOOKING_URL);
