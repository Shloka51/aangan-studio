// Loads T01–T20 into the configured store as sample data (rules brain, no messages sent).
// Rows use ids T01…T20 (T17a/T17b). Usage: npx tsx scripts/seed-samples.ts
import "@/cli/env";
import { replayFixtures } from "@/dashboard/data";
import { getStore } from "@/store";

(async () => {
  const store = await getStore();
  await replayFixtures(store);
  const rows = await store.dashboardRows();
  console.log(`store now has ${rows.length} completed enquiries; samples: ${rows.filter((r) => /^T\d/.test(r.id)).length}`);
})();
