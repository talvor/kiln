import { assertEquals, assertStringIncludes } from "@std/assert";
import { describeNews, NEWS_EVENTS } from "../src/news.ts";
import type { EventRecord } from "../src/store.ts";

Deno.test("a pull request marked ready is news that names the pull request", () => {
  assertEquals(NEWS_EVENTS.includes("pr.ready"), true);
  const text = describeNews({
    kind: "pr.ready",
    data: { request: 2, url: "https://github.com/acme/app/pull/7" },
  } as unknown as EventRecord);
  assertStringIncludes(text, "https://github.com/acme/app/pull/7");
  assertStringIncludes(text, "ready");
});
