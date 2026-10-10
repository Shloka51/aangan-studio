import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Aangan Enquiries", description: "Phone enquiry agent — outcomes, response times and cost" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
