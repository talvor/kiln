// An optional, scoped, short-lived GitHub token for workers. When `<config>/github.json` names a
// GitHub App, Kiln mints an installation token limited to one Project's repository and to the
// permissions listed (read-only by default), and gives it to that Project's workers as GH_TOKEN,
// so their own `gh` works. It expires in about an hour; Kiln mints a fresh one when it is close.
//   <config>/github.json   {
//     "app": { "id": 123456, "privateKeyFile": "~/.config/kiln/github-app.pem" },
//     "permissions": { "issues": "read", "pull_requests": "read", "contents": "read" },
//     "apiUrl": "https://api.github.com"
//   }
// Everything but `app` is optional. Without the file, workers get no token and use the `gh` tool.
import { join } from "@std/path";
import { REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import { ConfigError } from "./config_error.ts";

export interface GithubConfig {
  appId: number;
  privateKeyFile: string;
  permissions: Record<string, "read" | "write">;
  apiUrl: string;
}

/** What a worker needs to read a Project: nothing that writes. */
export const DEFAULT_PERMISSIONS: GithubConfig["permissions"] = {
  metadata: "read",
  issues: "read",
  pull_requests: "read",
  contents: "read",
  actions: "read",
};
/** A cached token is replaced when it has less than this left, so a launch never outlives it. */
export const REFRESH_BEFORE_MS = 10 * 60_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read `github.json` from the config directory; null when there is none. */
export async function loadGithub(configDir: string): Promise<GithubConfig | null> {
  const file = join(configDir, "github.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(file));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const fail = (why: string) => new ConfigError(`GitHub (${file}): ${why}`);
  if (!isObject(raw)) throw fail("must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!["app", "permissions", "apiUrl"].includes(key)) throw fail(`unknown field "${key}"`);
  }
  const app = raw.app;
  if (!isObject(app)) throw fail('"app" must be an object with "id" and "privateKeyFile"');
  for (const key of Object.keys(app)) {
    if (!["id", "privateKeyFile"].includes(key)) throw fail(`"app" has an unknown field "${key}"`);
  }
  const id = typeof app.id === "string" && /^\d+$/.test(app.id) ? Number(app.id) : app.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw fail('"app.id" must be the App\'s numeric id');
  }
  if (typeof app.privateKeyFile !== "string" || !app.privateKeyFile.trim()) {
    throw fail('"app.privateKeyFile" must be the path of the App\'s private key (.pem)');
  }
  let permissions = DEFAULT_PERMISSIONS;
  if (raw.permissions !== undefined) {
    if (!isObject(raw.permissions) || !Object.keys(raw.permissions).length) {
      throw fail('"permissions" must list permission names, e.g. {"issues": "read"}');
    }
    for (const [name, level] of Object.entries(raw.permissions)) {
      if (!/^[a-z_]+$/.test(name) || (level !== "read" && level !== "write")) {
        throw fail(`"permissions.${name}" must be "read" or "write"`);
      }
    }
    permissions = raw.permissions as GithubConfig["permissions"];
  }
  let apiUrl = "https://api.github.com";
  if (raw.apiUrl !== undefined) {
    if (typeof raw.apiUrl !== "string" || !/^https?:\/\//.test(raw.apiUrl)) {
      throw fail('"apiUrl" must be a URL, e.g. https://github.example.com/api/v3');
    }
    apiUrl = raw.apiUrl.replace(/\/+$/, "");
  }
  const home = Deno.env.get("HOME") ?? "";
  const keyFile = app.privateKeyFile.replace(/^~(?=\/|$)/, home);
  return { appId: id, privateKeyFile: keyFile, permissions, apiUrl };
}

const b64url = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const derLength = (n: number): number[] =>
  n < 0x80
    ? [n]
    : n < 0x100
    ? [0x81, n]
    : n < 0x10000
    ? [0x82, n >> 8, n & 0xff]
    : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];

/** A PKCS#1 RSA key (what GitHub hands out) wrapped as PKCS#8, which WebCrypto can import. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = [
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ];
  const octets = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

async function importKey(pem: string): Promise<CryptoKey> {
  const m = pem.match(/-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error("the private key is not a PEM RSA key");
  const der = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(der) : der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The short JWT that proves to GitHub that Kiln is the App. */
export async function appJwt(appId: number, pem: string, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importKey(pem),
    new TextEncoder().encode(`${head}.${claims}`),
  );
  return `${head}.${claims}.${b64url(new Uint8Array(signature))}`;
}

export interface TokenMinterOptions {
  /** The directory `github.json` is read from; read afresh, so edits apply to the next launch. */
  configDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Tokens for workers, by repository (`owner/repo`). Null when no App is configured or a token
 * cannot be had: the worker then carries on without one, and reads through the `gh` tool.
 */
export function createTokenMinter(opts: TokenMinterOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string | null>>();

  async function mint(config: GithubConfig, slug: string): Promise<string> {
    const jwt = await appJwt(config.appId, await Deno.readTextFile(config.privateKeyFile), now());
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const found = await doFetch(`${config.apiUrl}/repos/${slug}/installation`, { headers });
    if (!found.ok) {
      throw new Error(`the App is not installed on ${slug} (HTTP ${found.status})`);
    }
    const installation = (await found.json()).id;
    const made = await doFetch(`${config.apiUrl}/app/installations/${installation}/access_tokens`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        repositories: [slug.split("/")[1]],
        permissions: config.permissions,
      }),
    });
    if (!made.ok) throw new Error(`GitHub refused a token for ${slug} (HTTP ${made.status})`);
    const body = await made.json();
    if (typeof body.token !== "string") throw new Error("GitHub sent no token");
    cache.set(slug.toLowerCase(), { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  return {
    /** `slug` may be a function: it is only called when an App is configured. */
    async tokenFor(slugOf: string | (() => Promise<string | null>)): Promise<string | null> {
      let config: GithubConfig | null;
      try {
        config = await loadGithub(opts.configDir);
      } catch (err) {
        opts.warn?.("github.json is unusable; workers get no token", { err: String(err) });
        return null;
      }
      if (!config) return null;
      const slug = typeof slugOf === "string" ? slugOf : await slugOf();
      if (!slug) return null;
      const key = slug.toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expiresAt - now() > REFRESH_BEFORE_MS) return cached.token;
      const inFlight = pending.get(key);
      if (inFlight) return await inFlight;
      const work = mint(config, slug).catch((err) => {
        opts.warn?.("could not mint a worker token", { slug, err: String(err) });
        return null;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
      return await work;
    },
  };
}

/** `owner/repo` of a GitHub remote URL; null for anything else. */
export function repoSlug(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The Project's `owner/repo`: from its remote when that is a GitHub URL, otherwise as `gh` names
 * it (an ssh alias, an Enterprise host); null when neither can say.
 */
export async function projectSlug(clonePath: string, remoteUrl: string): Promise<string | null> {
  const parsed = repoSlug(remoteUrl);
  if (parsed) return parsed;
  try {
    const r = await run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner"],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
    const name = r.code === 0 ? JSON.parse(r.stdout).nameWithOwner : null;
    return typeof name === "string" && /^[^/\s]+\/[^/\s]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
