// The optional scoped, short-lived GitHub token for workers (a GitHub App's installation token).
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateKeyPairSync } from "node:crypto";
import { ConfigError } from "../src/config_error.ts";
import {
  appJwt,
  createTokenMinter,
  DEFAULT_PERMISSIONS,
  loadGithub,
  REFRESH_BEFORE_MS,
  repoSlug,
} from "../src/ghtoken.ts";

const keys = (type: "pkcs1" | "pkcs8") => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type, format: "pem" },
  });
  return { pem: pair.privateKey as string, publicPem: pair.publicKey as string };
};

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

for (const type of ["pkcs1", "pkcs8"] as const) {
  Deno.test(`the App's JWT is signed with a ${type} key and verifies`, async () => {
    const { pem, publicPem } = keys(type);
    const jwt = await appJwt(4242, pem, 1_700_000_000_000);
    const [head, claims, sig] = jwt.split(".");
    assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(head))), {
      alg: "RS256",
      typ: "JWT",
    });
    assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(claims))), {
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: 4242,
    });
    const der = Uint8Array.from(
      atob(publicPem.replace(/-----[A-Z ]+-----|\s+/g, "")),
      (c) => c.charCodeAt(0),
    );
    const pub = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    assert(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pub,
        fromB64url(sig),
        new TextEncoder().encode(`${head}.${claims}`),
      ),
    );
  });
}

Deno.test("a key that is not PEM is refused", async () => {
  await assertRejects(() => appJwt(1, "not a key"), Error, "not a PEM");
});

async function configWith(json: unknown): Promise<string> {
  const dir = await Deno.makeTempDir();
  if (json !== undefined) {
    await Deno.writeTextFile(join(dir, "github.json"), JSON.stringify(json));
  }
  return dir;
}

Deno.test("github.json is optional, and read-only by default", async () => {
  assertEquals(await loadGithub(await configWith(undefined)), null);
  const config = await loadGithub(
    await configWith({ app: { id: "123", privateKeyFile: "/keys/app.pem" } }),
  );
  assertEquals(config, {
    appId: 123,
    privateKeyFile: "/keys/app.pem",
    permissions: DEFAULT_PERMISSIONS,
    apiUrl: "https://api.github.com",
  });
  assert(Object.values(DEFAULT_PERMISSIONS).every((level) => level === "read"));
});

Deno.test("github.json says what is wrong with it", async () => {
  for (
    const [json, why] of [
      [[], "must be a JSON object"],
      [{}, '"app" must be an object'],
      [{ app: { id: 0, privateKeyFile: "k" } }, "numeric id"],
      [{ app: { id: 1 } }, "privateKeyFile"],
      [{ app: { id: 1, privateKeyFile: "k", secret: "x" } }, "unknown field"],
      [{ app: { id: 1, privateKeyFile: "k" }, token: "x" }, 'unknown field "token"'],
      [{ app: { id: 1, privateKeyFile: "k" }, permissions: { issues: "admin" } }, "read"],
      [{ app: { id: 1, privateKeyFile: "k" }, permissions: {} }, "permissions"],
      [{ app: { id: 1, privateKeyFile: "k" }, apiUrl: "ftp://x" }, "apiUrl"],
    ] as [unknown, string][]
  ) {
    const err = await assertRejects(
      async () => await loadGithub(await configWith(json)),
      ConfigError,
    );
    assertStringIncludes(err.message, why);
  }
});

/** A fake GitHub: the installation lookup and the token endpoint, with the calls it saw. */
function fakeGithub(opts: { installed?: boolean; lifetimeMs?: number } = {}) {
  const calls: { url: string; method: string; auth: string | null; body?: unknown }[] = [];
  let clock = 1_700_000_000_000;
  let issued = 0;
  const fake = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    calls.push({
      url,
      method,
      auth: headers.Authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/installation")) {
      return Promise.resolve(
        opts.installed === false ? new Response("{}", { status: 404 }) : Response.json({ id: 77 }),
      );
    }
    issued++;
    return Promise.resolve(Response.json({
      token: `ghs_token${issued}`,
      expires_at: new Date(clock + (opts.lifetimeMs ?? 3_600_000)).toISOString(),
    }, { status: 201 }));
  }) as typeof fetch;
  return { fake, calls, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function minterFor(github: ReturnType<typeof fakeGithub>, warnings: string[] = []) {
  const dir = await configWith({ app: { id: 9, privateKeyFile: "key.pem" } });
  await Deno.writeTextFile(join(dir, "key.pem"), keys("pkcs1").pem);
  // The key file is named relative to nothing: make it absolute, as a user would.
  await Deno.writeTextFile(
    join(dir, "github.json"),
    JSON.stringify({ app: { id: 9, privateKeyFile: join(dir, "key.pem") } }),
  );
  return createTokenMinter({
    configDir: dir,
    fetch: github.fake,
    now: github.now,
    warn: (m) => warnings.push(m),
  });
}

Deno.test("a token is limited to the one repository and to read access", async () => {
  const github = fakeGithub();
  const minter = await minterFor(github);
  assertEquals(await minter.tokenFor("talvor/kiln-fixture"), "ghs_token1");
  assertEquals(github.calls.map((c) => [c.method, c.url]), [
    ["GET", "https://api.github.com/repos/talvor/kiln-fixture/installation"],
    ["POST", "https://api.github.com/app/installations/77/access_tokens"],
  ]);
  assert(github.calls.every((c) => c.auth?.startsWith("Bearer ey")));
  assertEquals(github.calls[1].body, {
    repositories: ["kiln-fixture"],
    permissions: DEFAULT_PERMISSIONS,
  });
});

Deno.test("a token is reused until it is close to expiring, then replaced", async () => {
  const github = fakeGithub({ lifetimeMs: 3_600_000 });
  const minter = await minterFor(github);
  assertEquals(await minter.tokenFor("talvor/kiln-fixture"), "ghs_token1");
  github.advance(3_600_000 - REFRESH_BEFORE_MS - 1000);
  assertEquals(await minter.tokenFor("Talvor/Kiln-Fixture"), "ghs_token1");
  assertEquals(github.calls.length, 2);
  github.advance(2000);
  assertEquals(await minter.tokenFor("talvor/kiln-fixture"), "ghs_token2");
  // Each repository has its own token.
  assertEquals(await minter.tokenFor("talvor/other"), "ghs_token3");
});

Deno.test("simultaneous launches share one mint", async () => {
  const github = fakeGithub();
  const minter = await minterFor(github);
  const all = await Promise.all([1, 2, 3].map(() => minter.tokenFor("talvor/kiln-fixture")));
  assertEquals(all, ["ghs_token1", "ghs_token1", "ghs_token1"]);
  assertEquals(github.calls.length, 2);
});

Deno.test("without an App, or when GitHub says no, a worker simply gets no token", async () => {
  const none = createTokenMinter({ configDir: await configWith(undefined) });
  assertEquals(await none.tokenFor("talvor/kiln-fixture"), null);
  // With no App configured, the repository is never even looked up.
  let looked = 0;
  assertEquals(await none.tokenFor(() => (looked++, Promise.resolve("talvor/x"))), null);
  assertEquals(looked, 0);

  const warnings: string[] = [];
  const minter = await minterFor(fakeGithub({ installed: false }), warnings);
  assertEquals(await minter.tokenFor("talvor/kiln-fixture"), null);
  assertEquals(warnings, ["could not mint a worker token"]);

  const broken = await configWith({ app: {} });
  const bad: string[] = [];
  const unusable = createTokenMinter({ configDir: broken, warn: (m) => bad.push(m) });
  assertEquals(await unusable.tokenFor("talvor/kiln-fixture"), null);
  assertEquals(bad, ["github.json is unusable; workers get no token"]);
});

Deno.test("the repository comes from a GitHub remote", () => {
  assertEquals(repoSlug("https://github.com/talvor/kiln-fixture.git"), "talvor/kiln-fixture");
  assertEquals(repoSlug("git@github.com:talvor/kiln-fixture.git"), "talvor/kiln-fixture");
  assertEquals(repoSlug("https://github.com/talvor/kiln-fixture"), "talvor/kiln-fixture");
  assertEquals(repoSlug("/tmp/some/bare/remote"), null);
});
