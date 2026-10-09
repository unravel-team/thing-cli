import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function capture(options = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdin: options.stdin,
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stdinFor(messages) {
  return {
    async *[Symbol.asyncIterator]() {
      yield `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    }
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// One fake server: two versions of acme/q3-report (HTML, keyed), a PDF, and a
// tampered artifact whose hash header does not match its bytes.
const SOURCES = {
  "acme/q3-report/1": { body: "<!doctype html><h1>v1</h1>", type: "text/html; charset=utf-8", ext: ".html" },
  "acme/q3-report/2": { body: "<!doctype html><h1>v2</h1>", type: "text/html; charset=utf-8", ext: ".html" },
  "acme/spec/1": { body: "%PDF-1.7 binary", type: "application/pdf", ext: ".pdf" },
  "acme/tampered/1": { body: "<p>changed in transit</p>", type: "text/html", ext: ".html", hash: sha256("<p>original</p>") }
};
const LATEST = { "acme/q3-report": 2, "acme/spec": 1, "acme/tampered": 1 };
const LINK_KEY = "secret-key";

let requests = [];
function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, headers: init.headers || {} });
    if (url.pathname === "/api/v1/client-policy") return json({ client: "thing-cli", status: "current" });
    if (url.pathname === "/api/v1/artifacts") {
      return json({ artifacts: [{ id: "a1", slug: "q3-report", title: "Q3 report", teamSlug: "acme", projectSlug: null }] });
    }
    const match = /^\/api\/v1\/artifacts\/by-path\/([^/]+)\/([^/]+)(?:\/v\/(\d+))?\/download$/.exec(url.pathname);
    if (!match) return json({ error: `unexpected path ${url.pathname}` }, 404);
    const [, team, slug, pinned] = match;
    // q3-report is a legacy keyed artifact: no key, no bytes.
    if (slug === "q3-report" && url.searchParams.get("k") !== LINK_KEY) return json({ error: "not found" }, 404);
    const version = pinned ? Number(pinned) : LATEST[`${team}/${slug}`];
    const source = SOURCES[`${team}/${slug}/${version}`];
    if (!source) return json({ error: "not found" }, 404);
    return new Response(source.body, {
      headers: {
        "Content-Type": source.type,
        "Content-Disposition": `attachment; filename="${slug}-v${version}${source.ext}"`,
        "X-Thing-Version": String(version),
        "X-Thing-Content-Hash": source.hash || sha256(source.body)
      }
    });
  };
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "thing-pull-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "thing-pull-cwd-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "pull-token", THING_SERVER: "https://thing.test", THING_NO_UPDATE_NOTICES: "1" };
  return { cwd, env };
}

async function testPullByUrlWithKeyAndVersion() {
  const { cwd, env } = await setup();
  requests = [];
  const cli = capture({ cwd, env });
  const code = await run(["pull", `https://thing.test/acme/q3-report/v/1?k=${LINK_KEY}`, "--json"], cli.io);
  assert(code === 0, `pull by URL failed: ${cli.stderr() || cli.stdout()}`);
  const result = JSON.parse(cli.stdout());
  assert(result.version === 1, "a /v/1 URL should pin version 1");
  assert(result.path === join(cwd, "q3-report-v1.html"), `pull should save under the server's filename, got ${result.path}`);
  assert(readFileSync(result.path, "utf8") === SOURCES["acme/q3-report/1"].body, "saved bytes should match the pushed source");
  assert(result.contentType === "text/html" && result.contentHash === sha256(SOURCES["acme/q3-report/1"].body), "JSON should report type and verified hash");
  assert(!("bytes" in result), "JSON output should not include raw bytes");
  const download = requests.find((r) => r.url.pathname.endsWith("/download"));
  assert(download.url.searchParams.get("k") === LINK_KEY, "the link key from the URL should be forwarded");
  assert(download.headers.Authorization === "Bearer pull-token", "same-server URLs should carry the token");

  const again = capture({ cwd, env });
  assert(await run(["pull", `https://thing.test/acme/q3-report/v/1?k=${LINK_KEY}`], again.io) === 1, "pull should refuse to overwrite an existing file");
  assert(again.stderr().includes("--force"), "the overwrite refusal should mention --force");
  writeFileSync(result.path, "stale");
  const forced = capture({ cwd, env });
  assert(await run(["pull", `https://thing.test/acme/q3-report/v/1?k=${LINK_KEY}`, "--force"], forced.io) === 0, "--force should overwrite");
  assert(readFileSync(result.path, "utf8") === SOURCES["acme/q3-report/1"].body, "--force should replace the stale file");
}

async function testTokenNotSentToOtherHosts() {
  const { cwd, env } = await setup();
  requests = [];
  const cli = capture({ cwd, env });
  assert(await run(["pull", `https://elsewhere.test/acme/q3-report?k=${LINK_KEY}`, "--output", "-"], cli.io) === 0, `foreign-host pull failed: ${cli.stderr()}`);
  const download = requests.find((r) => r.url.pathname.endsWith("/download"));
  assert(download.url.origin === "https://elsewhere.test", "a URL ref should download from its own host");
  assert(!download.headers.Authorization, "the token must not be sent to a different host");
  assert(cli.stdout() === SOURCES["acme/q3-report/2"].body, "--output - should write the latest bytes to stdout");
}

async function testTeamSlugAndVersionPositional() {
  const { cwd, env } = await setup();
  const cli = capture({ cwd, env });
  assert(await run(["pull", "acme/spec", "--output", "docs/spec.pdf", "--json"], cli.io) === 0, `team/slug pull failed: ${cli.stderr()}`);
  const result = JSON.parse(cli.stdout());
  assert(result.path === join(cwd, "docs", "spec.pdf") && existsSync(result.path), "--output should create parent directories");
  assert(result.contentType === "application/pdf", "media should keep its content type");

  const pinned = capture({ cwd, env });
  assert(await run(["pull", "acme/q3-report", "7"], pinned.io) === 1, "an unknown version should fail");
  assert(pinned.stderr().includes("not found or not shared with you: acme/q3-report v7"), `404 should be explained, got: ${pinned.stderr()}`);
}

async function testBareNameResolvesOwnArtifact() {
  const { cwd, env } = await setup();
  requests = [];
  const cli = capture({ cwd, env });
  // q3-report needs a key, so this also proves a bare name reached the right by-path route.
  assert(await run(["pull", "q3-report", "--json"], cli.io) === 1, "keyed artifact without key should 404");
  const download = requests.find((r) => r.url.pathname.endsWith("/download"));
  assert(download.url.pathname === "/api/v1/artifacts/by-path/acme/q3-report/download", `bare name should resolve via the artifact list, got ${download.url.pathname}`);
}

async function testHashMismatchRejected() {
  const { cwd, env } = await setup();
  const cli = capture({ cwd, env });
  assert(await run(["pull", "acme/tampered"], cli.io) === 1, "a hash mismatch should fail the pull");
  assert(cli.stderr().includes("failed verification"), "the failure should say verification failed");
  assert(!existsSync(join(cwd, "tampered-v1.html")), "a tampered download must not be written");
}

async function testMcpFetchArtifact() {
  const { cwd, env } = await setup();
  const stdin = stdinFor([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch_artifact", arguments: { artifact: `https://thing.test/acme/q3-report?k=${LINK_KEY}` } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fetch_artifact", arguments: { artifact: "acme/spec" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fetch_artifact", arguments: { artifact: "acme/spec", path: join(cwd, "spec.pdf") } } }
  ]);
  const cli = capture({ cwd, env, stdin });
  assert(await run(["mcp"], cli.io) === 0, "MCP session should complete");
  const messages = cli.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert(messages[1].result.tools.some((tool) => tool.name === "fetch_artifact"), "MCP should advertise fetch_artifact");

  const text = messages[2].result;
  assert(!text.isError, `fetch_artifact failed: ${text.content[0].text}`);
  const meta = JSON.parse(text.content[0].text);
  assert(meta.version === 2 && meta.slug === "q3-report" && !("content" in meta), "first block should be metadata only");
  assert(text.content[1].text === SOURCES["acme/q3-report/2"].body, "second block should be the raw document");

  assert(messages[3].result.isError && messages[3].result.content[0].text.includes("pass `path`"), "binary fetch without a path should ask for one");
  const saved = JSON.parse(messages[4].result.content[0].text);
  assert(saved.path === join(cwd, "spec.pdf") && readFileSync(saved.path, "utf8") === SOURCES["acme/spec/1"].body, "binary fetch with a path should save it");
}

const originalFetch = globalThis.fetch;
installFetch();
try {
  await testPullByUrlWithKeyAndVersion();
  await testTokenNotSentToOtherHosts();
  await testTeamSlugAndVersionPositional();
  await testBareNameResolvesOwnArtifact();
  await testHashMismatchRejected();
  await testMcpFetchArtifact();
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Pull tests passed");
