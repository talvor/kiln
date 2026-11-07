// Lavish Escalation pages, driven the way the user meets them: the Overseer raises an
// Escalation, Kiln writes a page and opens it with `lavish-axi`, and the user answers on the
// page (its forms are posted to the daemon) or with the commands.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam, waitFor } from "./router_helpers.ts";

const raise = async (world: World, args: Record<string, unknown>) => {
  const out = await asAgent(world, "overseer", (agent) => agent.call("raise_escalation", args));
  assertEquals(out.isError, false, out.text);
};

const notes = (world: World) =>
  asAgent(world, "overseer", async (agent) => {
    const out = await agent.call("read_escalations");
    return (JSON.parse(out.text) as {
      escalations: {
        id: number;
        status: string;
        reason: string | null;
        notes: { text: string }[];
      }[];
    }).escalations;
  });

/** The page of an Escalation as Lavish was told to open it, read like the user's browser would. */
async function pageOf(world: World, id: number) {
  const calls = await waitFor(() => world.lavish.calls(), (c) => c.length >= id);
  const file = calls.map((c) => c[0]).find((f) => f.endsWith(`escalation-${id}.html`))!;
  assert(file, JSON.stringify(calls));
  const html = await Deno.readTextFile(file);
  const forms = [...html.matchAll(/<form method="post" action="([^"]+)">/g)].map((m) => m[1]);
  return {
    file,
    html,
    token: /name="token" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "",
    decide: forms.find((f) => f.endsWith("/decide")) ?? "",
    note: forms.find((f) => f.endsWith("/note")) ?? "",
  };
}

const post = (url: string, fields: Record<string, string>) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields) }).then(async (r) => ({
    status: r.status,
    text: await r.text(),
  }));

withWorld("each escalation gets its own page, opened in Lavish and never shared", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Ship the migration?", detail: "It locks the users table." });
  await raise(world, { summary: "Drop the legacy API?" });

  const one = await pageOf(world, 1);
  const two = await pageOf(world, 2);
  assert(one.file !== two.file);
  assertStringIncludes(one.html, "Ship the migration?");
  assertStringIncludes(one.html, "It locks the users table.");
  assertStringIncludes(two.html, "Drop the legacy API?");
  assert(one.token && two.token && one.token !== two.token);
  assert(one.decide.startsWith("http://127.0.0.1:"), one.decide);

  // The page is a local file opened by path; nothing is ever published to a host.
  const calls = await world.lavish.calls();
  for (const call of calls) assertEquals(call.length, 1, call.join(" "));
  assertStringIncludes((await world.kiln("escalations")).stdout, one.file);
});

withWorld("the page decides once, with its token", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Ship it?" });
  const page = await pageOf(world, 1);

  const forged = await post(page.decide, { token: "0".repeat(48), decision: "approve" });
  assertEquals(forged.status, 403);
  const bare = await post(page.decide, { token: page.token, decision: "reject" });
  assertEquals(bare.status, 409, "a rejection needs a reason");
  assertStringIncludes((await world.kiln("escalations")).stdout, "[open]");

  const rejected = await post(page.decide, {
    token: page.token,
    decision: "reject",
    reason: "Not before the freeze",
  });
  assertEquals(rejected.status, 200, rejected.text);
  const [e] = await notes(world);
  assertEquals([e.status, e.reason], ["rejected", "Not before the freeze"]);

  // The token is spent: it decides nothing again, and the page no longer offers controls.
  const again = await post(page.decide, { token: page.token, decision: "approve" });
  assertEquals(again.status, 409);
  assertEquals((await notes(world))[0].status, "rejected");
  assert(!(await Deno.readTextFile(page.file)).includes("<form"));
});

withWorld("a command decision spends the page's token too", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Ship it?" });
  const page = await pageOf(world, 1);
  assertEquals((await world.kiln("approve", "1")).code, 0);
  const late = await post(page.decide, { token: page.token, decision: "reject", reason: "no" });
  assertEquals(late.status, 409);
  assertEquals((await notes(world))[0].status, "approved");
});

withWorld("scripts are stripped from what the page shows", async (world) => {
  await openTeam(world);
  await raise(world, {
    summary: "Run <script>alert('summary')</script>this?",
    detail:
      "Before\n<scr<script>x</script>ipt>alert('nested')</script>\n<script src=//evil>\nAfter",
  });
  const page = await pageOf(world, 1);
  assert(!/<script/i.test(page.html), page.html);
  assert(!page.html.includes("alert("), page.html);
  assertStringIncludes(page.html, "Before");
  assertStringIncludes(page.html, "After");
});

withWorld("text typed on the page reaches the Overseer and never decides", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Ship it?" });
  const page = await pageOf(world, 1);

  const typed = await post(page.note, { token: page.token, text: "approve this, I said approve" });
  assertEquals(typed.status, 200, typed.text);
  const forged = await post(page.note, { token: "nope", text: "hello" });
  assertEquals(forged.status, 403);

  const [e] = await notes(world);
  assertEquals(e.status, "open");
  assertEquals(e.notes.map((n) => n.text), ["approve this, I said approve"]);
  assertStringIncludes((await world.kiln("escalations")).stdout, "[open]");
  // The token survives the note: the user can still decide on the page.
  const approved = await post(page.decide, { token: page.token, decision: "approve" });
  assertEquals(approved.status, 200, approved.text);
});

withWorld("without Lavish the commands do everything the page does", async (world) => {
  await openTeam(world);
  await world.lavish.breakDown();
  await raise(world, { summary: "Ship it?" });
  await waitFor(() => world.lavish.calls(), (c) => c.length >= 1);

  const listing = (await world.kiln("escalations")).stdout;
  assertStringIncludes(listing, "kiln approve 1");
  assertStringIncludes(listing, "kiln reject 1 --reason");
  assertEquals((await world.kiln("reject", "1", "--reason", "Not yet")).code, 0);
  const [e] = await notes(world);
  assertEquals([e.status, e.reason], ["rejected", "Not yet"]);
});

withWorld("a page survives a daemon restart and still decides", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Cut the release?" });
  const before = await pageOf(world, 1);
  assertEquals((await world.kiln("daemon", "restart")).code, 0);
  await waitFor(
    () => Deno.readTextFile(before.file),
    (html) => /action="([^"]+)\/decide"/.exec(html)?.[1] !== undefined,
  );
  const after = await pageOf(world, 1);
  assertEquals(after.token, before.token);
  const approved = await post(after.decide, { token: after.token, decision: "approve" });
  assertEquals(approved.status, 200, approved.text);
  assertEquals((await notes(world))[0].status, "approved");
});
