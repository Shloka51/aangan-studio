// Entry point for the Vaani call server: `npm run voice-server` (and the Dockerfile).
import "@/cli/env";
import { calcomLink } from "@/adapters/booking/calcom";
import { createBrain } from "@/adapters/brain";
import { getStore } from "@/store";
import { createVaaniServer } from "./vaani-ws";

(async () => {
  const port = Number(process.env.PORT ?? 8787);
  const server = createVaaniServer({
    core: { brain: await createBrain(), bookingLink: calcomLink },
    store: await getStore(),
    token: process.env.VAANI_BYOL_TOKEN?.trim() || undefined,
  });
  server.listen(port, () =>
    console.log(
      `Vaani call server on :${port} — brain: ${process.env.GEMINI_API_KEY ? "gemini" : "rules"}, store: ${process.env.SUPABASE_URL ? "supabase" : "memory"}, auth: ${process.env.VAANI_BYOL_TOKEN ? "bearer token" : "OFF (dev only)"}`,
    ),
  );
})();
