// Studio rules expressed as numbers. Each value cites where it comes from.

export const STUDIO = {
  name: "Aangan Studio",
  timezone: "Asia/Kolkata",

  /** services.md: "cannot begin execution on a project that needs to be ready in under 6 weeks". */
  minLeadWeeks: 6,
  /**
   * qualified.md §3 + T07 front desk: "a room redesign with execution takes at least
   * 8–10 weeks from start to finish". A completion deadline closer than this fails.
   */
  minCompletionWeeks: 10,
  /** qualified.md §3: site must be available for execution within 8–10 weeks. */
  maxSiteWaitWeeks: 10,

  /** T18 front desk: "Our commercial projects are typically 500 sq ft or more." */
  commercialMinSqft: 500,
  /** services.md: offices "up to approximately 3,000 sq ft". */
  commercialMaxSqft: 3000,

  /**
   * qualified.md §4: flag only a volunteered number "clearly below" any project of that
   * scope. We call it clearly below when it is under this fraction of the internal floor.
   */
  budgetClearlyLowFraction: 0.5,
  budgetTightFraction: 0.8,

  /** PDF header: front desk hours 10am–7pm; WhatsApp "working days". Mon–Sat. */
  businessHours: { startHour: 10, endHour: 19, days: [1, 2, 3, 4, 5, 6] },

  /** T09: "someone senior call you back within 15 minutes". */
  escalationCallbackMinutes: 15,
  /** Missed / dropped calls: call back within this many minutes (in business hours). */
  callbackMinutes: 15,

  /** Festival dates used to resolve "before Diwali" etc. */
  events: {
    diwali: ["2026-11-08", "2027-10-29", "2028-10-17"],
    dussehra: ["2026-10-20", "2027-10-09", "2028-09-27"],
    christmas: ["2026-12-25", "2027-12-25", "2028-12-25"],
    "new year": ["2027-01-01", "2028-01-01", "2029-01-01"],
    ganpati: ["2027-09-04", "2028-08-23"],
  } as Record<string, string[]>,
};

export const CRITERIA_NAMES: Record<number, string> = {
  1: "Real project (design + execution)",
  2: "In service area (Pune / PCMC)",
  3: "Realistic timeline",
  4: "Budget sanity",
  5: "Decision-maker present or represented",
};
