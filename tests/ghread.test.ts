// Workers read their Project's GitHub repository through an allowlisted `gh`, run by the daemon.
import { assertEquals } from "@std/assert";
import { refuseGhArgs, repoSlug } from "../src/ghread.ts";

const SLUG = "talvor/kiln-fixture";

Deno.test("the repository comes from a GitHub remote", () => {
  assertEquals(repoSlug("https://github.com/talvor/kiln-fixture.git"), SLUG);
  assertEquals(repoSlug("git@github.com:talvor/kiln-fixture.git"), SLUG);
  assertEquals(repoSlug("https://github.com/talvor/kiln-fixture"), SLUG);
  assertEquals(repoSlug("/tmp/some/bare/remote"), null);
});

Deno.test("reads of the Project's own repository are allowed", () => {
  for (
    const args of [
      ["issue", "view", "1"],
      ["issue", "view", "1", "--comments"],
      ["issue", "view", `https://github.com/${SLUG}/issues/1`, "--json", "title,body"],
      ["issue", "list", "--state", "open", "--limit", "5"],
      ["pr", "view", "3", "--json", "state"],
      ["pr", "diff", "3"],
      ["pr", "checks", "3"],
      ["run", "list"],
      ["repo", "view"],
      ["repo", "view", SLUG],
      ["api", `repos/${SLUG}/issues/1`],
      ["api", `/repos/${SLUG}/issues/1/comments`, "--paginate", "--jq", ".[].body"],
      ["api", "repos/{owner}/{repo}/pulls/3"],
      ["api", `repos/${SLUG}/issues`, "-X", "GET"],
      ["api", `repos/${SLUG}/issues`, "--method=GET"],
    ]
  ) assertEquals(refuseGhArgs(args, SLUG), null, args.join(" "));
});

Deno.test("anything that writes, or reaches elsewhere, is refused", () => {
  for (
    const args of [
      [],
      "issue view 1",
      ["auth", "token"],
      ["auth", "status"],
      ["issue", "create", "--title", "x"],
      ["issue", "close", "1"],
      ["issue", "comment", "1", "--body", "x"],
      ["pr", "create"],
      ["pr", "merge", "3"],
      ["repo", "delete", SLUG],
      ["repo", "view", "someone/else"],
      ["issue", "view", "1", "--repo", "someone/else"],
      ["issue", "view", "1", "--repo=someone/else"],
      ["issue", "view", "1", "-R", "someone/else"],
      ["issue", "view", "1", "-Rsomeone/else"],
      ["issue", "view", "1", "--web"],
      ["issue", "view", "1", "-w"],
      ["issue", "view", "https://github.com/someone/else/issues/1"],
      ["issue", "view", "https://evil.example/talvor/kiln-fixture/issues/1"],
      ["issue", "view", `https://github.com/${SLUG}-other/issues/1`],
      ["pr", "view", "3", "--hostname", "ghe.example"],
      ["api", "graphql"],
      ["api", "user"],
      ["api", "repos/someone/else/issues"],
      ["api", `repos/${SLUG}/../../user`],
      ["api", `repos/${SLUG}/issues`, "-X", "POST"],
      ["api", `repos/${SLUG}/issues`, "--method", "DELETE"],
      ["api", `repos/${SLUG}/issues`, "--method=PATCH"],
      ["api", `repos/${SLUG}/issues`, "-XPOST"],
      ["api", `repos/${SLUG}/issues`, "-f", "title=x"],
      ["api", `repos/${SLUG}/issues`, "-F", "title=x"],
      ["api", `repos/${SLUG}/issues`, "--field", "title=x"],
      ["api", `repos/${SLUG}/issues`, "--raw-field=title=x"],
      ["api", `repos/${SLUG}/issues`, "--input", "body.json"],
      ["api", `repos/${SLUG}/issues`, "-H", "X-HTTP-Method-Override: DELETE"],
      ["api"],
    ]
  ) {
    assertEquals(typeof refuseGhArgs(args, SLUG), "string", JSON.stringify(args));
  }
});
