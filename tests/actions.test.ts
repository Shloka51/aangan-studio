// Handoff, booking and callback actions, with mocked transports (no network).
import { describe, expect, it, vi } from "vitest";
import { executeActions } from "@/adapters/actions";
import { calcomLink } from "@/adapters/booking/calcom";
import { ResendTransport } from "@/adapters/handoff/email";
import { splitMessage, TelegramTransport, type Transport } from "@/adapters/handoff/telegram";
import { processEnquiry } from "@/core/session";
import { MemoryStore } from "@/store/memory";
import { deps } from "./support/deps";
import { loadFixtures, toEnquiry } from "./support/fixtures";

const fixtures = loadFixtures();
const run = async (id: string) => {
  const e = toEnquiry(fixtures.find((f) => f.id === id)!);
  return processEnquiry(e, deps(e));
};
class FakeTransport implements Transport {
  sent: { to: string; subject: string; body: string }[] = [];
  async send(to: "designer" | "studio_head", subject: string, body: string) {
    this.sent.push({ to, subject, body });
    return { status: "sent" as const };
  }
}

describe("action execution", () => {
  it("qualified lead → booking recorded + note to designer on Telegram and email", async () => {
    const store = new MemoryStore(), tg = new FakeTransport(), mail = new FakeTransport();
    await executeActions(await run("T01"), { store, telegram: tg, email: mail });
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0].url).toMatch(/^https:\/\/cal\.com\/.+name=Priya/);
    expect(tg.sent[0]).toMatchObject({ to: "designer" });
    expect(tg.sent[0].body).toMatch(/Kothrud/);
    expect(mail.sent).toHaveLength(1);
    expect(store.handoffs.map((h) => h.channel)).toEqual(["telegram", "email"]);
  });

  it("complaint → studio head alerted, nothing sent to a designer as a lead", async () => {
    const store = new MemoryStore(), tg = new FakeTransport(), mail = new FakeTransport();
    await executeActions(await run("T09"), { store, telegram: tg, email: mail });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({ to: "studio_head" });
    expect(tg.sent[0].subject).toMatch(/ESCALATION/);
    expect(store.bookings).toHaveLength(0);
  });

  it("T17: dropped call queues a callback; the caller ringing back resolves it", async () => {
    const store = new MemoryStore(), tg = new FakeTransport(), mail = new FakeTransport();
    await executeActions(await run("T17a"), { store, telegram: tg, email: mail });
    expect(await store.pendingCallbacks()).toHaveLength(1);
    await executeActions(await run("T17b"), { store, telegram: tg, email: mail });
    expect(await store.pendingCallbacks()).toHaveLength(0);
    expect(store.callbacks[0].status).toBe("resolved_by_caller");
    expect(store.bookings).toHaveLength(1);
  });

  it("T07: impossible timeline stores a follow-up, not a callback alert", async () => {
    const store = new MemoryStore(), tg = new FakeTransport();
    await executeActions(await run("T07"), { store, telegram: tg, email: new FakeTransport() });
    expect(store.callbacks).toMatchObject([{ kind: "followup", status: "pending" }]);
    expect(tg.sent).toHaveLength(0);
  });

  it("declines send nothing to designers", async () => {
    for (const id of ["T03", "T04", "T10", "T18", "T19"]) {
      const tg = new FakeTransport();
      await executeActions(await run(id), { store: new MemoryStore(), telegram: tg, email: new FakeTransport() });
      expect(tg.sent, id).toHaveLength(0);
    }
  });
});

describe("transports (fetch mocked)", () => {
  it("Telegram posts to the Bot API with the designer chat id", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const t = new TelegramTransport("TEST_TOKEN", { designer: "111", studio_head: "222" }, f as unknown as typeof fetch);
    expect(await t.send("studio_head", "Subj", "Body")).toEqual({ status: "sent" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTEST_TOKEN/sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "222", text: "Subj\n\nBody" });
  });

  it("Telegram reports failure instead of throwing", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 400 }));
    const t = new TelegramTransport("T", { designer: "1", studio_head: "1" }, f as unknown as typeof fetch);
    expect((await t.send("designer", "s", "b")).status).toBe("failed");
  });

  it("without credentials, transports stub instead of calling out", async () => {
    const f = vi.fn();
    expect((await new TelegramTransport(undefined, { designer: undefined, studio_head: undefined }, f as unknown as typeof fetch).send("designer", "s", "b")).status).toBe("stubbed");
    expect((await new ResendTransport(undefined, "x", { designer: undefined, studio_head: undefined }, f as unknown as typeof fetch).send("designer", "s", "b")).status).toBe("stubbed");
    expect(f).not.toHaveBeenCalled();
  });

  it("Resend posts the note as text and escaped HTML", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await new ResendTransport("re_test", "from@x", { designer: "a@x.com", studio_head: "b@x.com" }, f as unknown as typeof fetch).send("designer", "S", "<b>hi</b>");
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ to: ["a@x.com"], subject: "S", text: "<b>hi</b>" });
    expect(body.html).toContain("&lt;b&gt;");
  });

  it("splits long Telegram messages", () => {
    expect(splitMessage("a\n".repeat(5000)).every((p) => p.length <= 4000)).toBe(true);
  });

  it("Cal.com link is prefilled", () => {
    expect(calcomLink({ name: "Ritu Kapoor", number: "+91 98", notes: "full_home in Pimple Saudagar" }, "https://cal.com/aangan/consult")).toBe(
      "https://cal.com/aangan/consult?name=Ritu+Kapoor&attendeePhoneNumber=%2B9198&notes=full_home+in+Pimple+Saudagar",
    );
  });
});
