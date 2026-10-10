// Basic-auth gate for the dashboard. The Vaani webhook has its own HMAC check.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  // Explicit opt-in for a public demo dashboard (e.g. for reviewers). Off by default.
  if (process.env.DASHBOARD_PUBLIC === "1") return NextResponse.next();
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === "production") return new NextResponse("Set DASHBOARD_PASSWORD to enable the dashboard.", { status: 503 });
    return NextResponse.next();
  }
  const auth = req.headers.get("authorization") ?? "";
  const [, encoded] = auth.split(" ");
  const supplied = encoded ? atob(encoded).split(":").slice(1).join(":") : "";
  if (supplied === password) return NextResponse.next();
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Aangan dashboard"' } });
}

export const config = { matcher: ["/((?!api/|_next/|favicon.ico).*)"] };
