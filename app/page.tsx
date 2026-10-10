import { loadRows } from "@/dashboard/data";
import { computeMetrics } from "@/dashboard/metrics";
import { formatIST } from "@/core/handoff";

export const dynamic = "force-dynamic";

const pct = (n: number) => `${Math.round(n)}%`;
const inr = (n: number) => `₹${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-IN")}`;
const secs = (s?: number) => (s === undefined ? "—" : s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);
const REASON_LABEL: Record<string, string> = {
  out_of_area: "Out of area",
  advice_only: "Advice only",
  out_of_scope_type: "Out-of-scope type",
  below_min_commercial: "Below min commercial",
  above_max_commercial: "Above max commercial",
  budget_mismatch: "Budget mismatch",
  impossible_timeline: "Impossible timeline",
  multiple: "Several criteria",
};

function Bar({ name, n, max, series = 1 }: { name: string; n: number; max: number; series?: 1 | 2 }) {
  return (
    <div className="bar-row" title={`${name}: ${n}`}>
      <span className="name">{name}</span>
      <div className="track">
        <div className={`fill${series === 2 ? " s2" : ""}`} style={{ width: `${max ? (n / max) * 100 : 0}%` }} />
      </div>
      <span className="n">{n}</span>
    </div>
  );
}

export default async function Dashboard() {
  const { rows, mode } = await loadRows();
  const m = computeMetrics(rows);
  const maxOutcome = Math.max(1, ...m.outcomes.map((o) => o.count));
  const { inHours, afterHours } = m.afterHours;
  const maxSplit = Math.max(1, inHours.received, afterHours.received);

  return (
    <main>
      <header>
        <h1>Aangan Studio · Phone enquiries</h1>
        <span className="sub">{mode === "live" ? "Live store" : "Demo: T01–T20 replayed"} · {m.received} enquiries</span>
      </header>

      {mode === "demo" && (
        <div className="banner">
          Demo mode — Supabase isn&apos;t configured, so this page replays the September phone transcripts through the core (rules brain, no messages sent). Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to see live calls.
        </div>
      )}

      <section className="tiles" aria-label="Headline numbers">
        <div className="tile"><div className="label">Enquiries received</div><div className="value">{m.received}</div><div className="hint">{m.unanswered} not answered live</div></div>
        <div className="tile"><div className="label">Answered &lt; 5 min</div><div className="value">{pct(m.answeredUnder5MinPct)}</div><div className="hint">of all enquiries</div></div>
        <div className="tile"><div className="label">Median response</div><div className="value">{secs(m.medianResponseSec)}</div><div className="hint">to first agent reply</div></div>
        <div className="tile"><div className="label">Qualification rate</div><div className="value">{pct(m.qualificationRatePct)}</div><div className="hint">{m.qualified} of {m.newProjectEnquiries} new-project enquiries</div></div>
        <div className="tile"><div className="label">Consultations booked</div><div className="value">{m.booked}</div><div className="hint">booking links sent</div></div>
        <div className="tile"><div className="label">Cost to run</div><div className="value">{inr(m.costInr)}</div><div className="hint">{inr(m.costPerEnquiryInr)}/enquiry{m.costPerBookingInr !== undefined ? ` · ${inr(m.costPerBookingInr)}/booking` : ""}</div></div>
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Outcomes</h2>
          <div className="bars">
            {m.outcomes.map((o) => (
              <Bar key={o.kind} name={o.kind[0] + o.kind.slice(1).toLowerCase()} n={o.count} max={maxOutcome} />
            ))}
          </div>
          {m.declineReasons.length > 0 && (
            <ul className="reasons" aria-label="Decline reasons">
              {m.declineReasons.map((d) => (
                <li key={d.reason}><span>{REASON_LABEL[d.reason] ?? d.reason}</span><span>{d.count}</span></li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Office hours vs after hours</h2>
          <div className="legend">
            <span><span className="swatch" style={{ background: "var(--series-1)" }} />Office hours (Mon–Sat 10am–7pm)</span>
            <span><span className="swatch" style={{ background: "var(--series-2)" }} />After hours</span>
          </div>
          <div className="split">
            {(["received", "qualified", "booked"] as const).map((k) => (
              <div className="split-group" key={k}>
                <div className="gname">{k[0].toUpperCase() + k.slice(1)}</div>
                <Bar name="Office" n={inHours[k]} max={maxSplit} />
                <Bar name="After hours" n={afterHours[k]} max={maxSplit} series={2} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Recent enquiries</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Received</th><th>Caller</th><th>Outcome</th><th>Detail</th><th>Booked</th><th style={{ textAlign: "right" }}>Cost</th></tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td>{formatIST(r.receivedAt)}{r.afterHours ? <span className="muted"> · after hours</span> : null}</td>
                  <td>{r.callerName ?? <span className="muted">unknown</span>}<span className="muted"> {r.callerNumber}</span></td>
                  <td><span className="pill">{r.outcome ?? "—"}</span></td>
                  <td className="muted">{r.recovery ? "Recovery — handle with care" : r.declineReason ? REASON_LABEL[r.declineReason] : r.qualification === "UNCERTAIN" ? "Qualified, some criteria uncertain" : ""}</td>
                  <td>{r.booked ? "Yes" : "—"}</td>
                  <td className="num">{inr(r.costInr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
