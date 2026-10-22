// Agents reading and answering artifacts: get, responses, respond, link
// resolution, push notes, and the matching MCP tools. Runs against a stub
// server, like cli-smoke.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const home = await mkdtemp(join(tmpdir(), "thing-read-home-"));
const cwd = await mkdtemp(join(tmpdir(), "thing-read-cwd-"));
const SERVER = "https://thing.test";
mkdirSync(join(home, "thing"));
const ENV = { ...process.env, XDG_CONFIG_HOME: home, THING_SERVER: "", THING_TOKEN: "" };
writeFileSync(join(home, "thing", "config.json"), JSON.stringify({
  server: SERVER,
  activeAccount: "default",
  accounts: { default: { server: SERVER, token: "tok" } }
}));

const HTML = '<!doctype html><html><head><meta name="thing:inputs" content="feedback"></head><body>deck</body></html>';
const PDF = Buffer.from("%PDF-1.4 fake");
const meta = {
  artifact: { id: "art-1", slug: "deck", title: "Deck", team: "acme", visibility: "team", latestVersion: 2, contentType: "text/html; charset=utf-8", url: `${SERVER}/acme/deck` },
  versions: [{ id: "ver-2", number: 2 }, { id: "ver-1", number: 1 }],
  access: "viewer"
};
const posted = [];
const seen = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const auth = init.headers?.Authorization;
  seen.push({ path: url.pathname, query: url.search, auth });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const p = url.pathname;
  if (p === "/api/v1/artifacts/by-path/acme/deck") return json(meta);
  if (url.host !== "thing.test") assert(!auth, `this account's token must never reach ${url.host}`);
  if (url.host === "alias.test") return json({ error: "the alias host should not be asked" }, 500);
  if (p === "/api/v1/artifacts/by-path/acme/aliased") return json({ ...meta, artifact: { ...meta.artifact, slug: "aliased", url: "https://alias.test/acme/aliased" } });
  if (p === "/api/v1/artifacts/by-path/pub/open" && url.host === "thing.test") return json({ error: "not found" }, 404);
  if (p === "/api/v1/artifacts/by-path/pub/open") {
    return json({ ...meta, artifact: { ...meta.artifact, id: "art-pub", team: "pub", slug: "open", visibility: "public" }, access: "viewer" });
  }
  if (p === "/api/v1/artifacts/by-path/acme/deck/download" || p === "/api/v1/artifacts/by-path/acme/deck/v/1/download") {
    const v = p.includes("/v/1/") ? 1 : 2;
    return new Response(HTML.replace("deck", `deck v${v}`), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="deck-v${v}.html"`, "X-Thing-Version": String(v) } });
  }
  if (p === "/api/v1/artifacts/by-path/acme/brief/download") {
    return new Response(PDF, { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="brief-v1.pdf"', "X-Thing-Version": "1" } });
  }
  if (p === "/api/v1/artifacts/by-path/acme/brief") return json({ ...meta, artifact: { ...meta.artifact, id: "art-2", slug: "brief", contentType: "application/pdf" } });
  if (p === "/api/v1/artifacts/by-path/acme/missing") return json({ error: "not found" }, 404);
  if (p === "/api/v1/artifacts/art-1/responses" && init.method === "POST") {
    const body = JSON.parse(String(init.body));
    posted.push(body);
    return json({ id: "res-1", versionId: body.versionId, version: body.versionId === "ver-1" ? 1 : 2, collection: body.collection, data: body.data }, 201);
  }
  if (p === "/api/v1/artifacts/art-1/responses") {
    if (url.searchParams.get("format") === "csv") return new Response("Response ID,Name\nres-1,Ada\n", { headers: { "Content-Type": "text/csv" } });
    const offset = Number(url.searchParams.get("offset") || 0);
    const all = [{ id: "res-1", collection: "feedback", version: 2, data: { stance: "agree" } }, { id: "res-2", collection: "feedback", version: 2, data: { stance: "disagree" } }];
    return json({ total: all.length, responses: all.slice(offset, offset + 1), limit: 1, offset });
  }
  if (p === "/api/v1/artifacts/art-1/comments") return json({ comments: [] });
  if (p === "/api/v1/artifacts" && init.method === "POST") {
    return json({ artifact: { id: "art-1", slug: "deck", team: "acme", visibility: "team", url: `${SERVER}/acme/deck` }, version: { id: "ver-3", number: 3 }, notes: ["Inputs is not enabled for this team or creator yet."] }, 200);
  }
  if (p === "/api/v1/artifacts") return json({ artifacts: [] });
  return json({ error: `unexpected ${p}` }, 500);
};

async function cli(args) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { cwd, env: ENV, stdout: { write: (c) => { stdout += String(c); } }, stderr: { write: (c) => { stderr += String(c); } } });
  return { code, stdout, stderr };
}

// get: text to stdout, pinned versions, links, files
{
  const latest = await cli(["get", "acme/deck"]);
  assert(latest.code === 0, `get team/slug failed: ${latest.stderr}`);
  assert(latest.stdout.includes("deck v2"), "get prints the latest HTML to stdout");

  const pinned = await cli(["get", `${SERVER}/acme/deck/v/1`, "--json"]);
  const data = JSON.parse(pinned.stdout);
  assert(data.version === 1 && data.content.includes("deck v1"), "a /v/N link reads that version");
  assert(data.artifact.id === "art-1", "--json carries the artifact metadata");

  const saved = await cli(["get", "acme/deck", "--version", "1", "--output", join(cwd, "out.html")]);
  assert(saved.code === 0 && readFileSync(join(cwd, "out.html"), "utf8").includes("deck v1"), "--output writes the file");

  const pdf = await cli(["get", "acme/brief"]);
  assert(pdf.code === 0 && existsSync(join(cwd, "brief-v1.pdf")), "binary content is saved under its download name, never dumped to stdout");
  const again = await cli(["get", "acme/brief"]);
  assert(again.code !== 0 && again.stderr.includes("--output"), "an existing file is not overwritten");

  const missing = await cli(["get", "acme/missing"]);
  assert(missing.code !== 0 && missing.stderr.includes("not found"), "a missing artifact fails clearly");

  const elsewhere = await cli(["versions", "https://other.example/pub/open", "--json"]);
  assert(elsewhere.code === 0, `a public link on another server is read without the token: ${elsewhere.stdout}${elsewhere.stderr}`);
  const aliased = await cli(["versions", "https://alias.test/acme/aliased", "--json"]);
  assert(aliased.code === 0, `a link on another host for this account's server keeps the token: ${aliased.stdout}${aliased.stderr}`);
}

// responses: pages through everything, csv passthrough
{
  const all = await cli(["responses", "acme/deck", "--json"]);
  const data = JSON.parse(all.stdout);
  assert(data.responses.length === 2 && data.total === 2, "responses pages until total");
  assert(seen.some((s) => s.path.endsWith("/responses") && s.query.includes("scope=all")), "responses defaults to every respondent");
  const csv = await cli(["responses", "acme/deck", "--csv"]);
  assert(csv.stdout.startsWith("Response ID"), "--csv prints the export");
}

// respond: version id from metadata, data from --data or --field
{
  const one = await cli(["respond", "acme/deck", "feedback", "--field", "stance=agree", "--field", "score=4", "--field", "final=true", "--json"]);
  assert(one.code === 0, `respond failed: ${one.stderr}`);
  const body = posted.at(-1);
  assert(body.versionId === "ver-2" && body.collection === "feedback", "respond answers the latest version");
  assert(body.data.stance === "agree" && body.data.score === 4 && body.data.final === true, "--field values are typed");
  assert(typeof body.requestId === "string" && body.requestId.length > 8, "respond sends a request id");

  await cli(["respond", `${SERVER}/acme/deck/v/1`, "feedback", "--data", '{"stance":"disagree"}']);
  assert(posted.at(-1).versionId === "ver-1" && posted.at(-1).data.stance === "disagree", "a /v/N link answers that version, --data takes JSON");

  const bad = await cli(["respond", "acme/deck", "feedback", "--data", "[1,2]"]);
  assert(bad.code !== 0, "respond rejects a non-object payload before sending");
}

// push passes server notes through
{
  const file = join(cwd, "deck.html");
  writeFileSync(file, HTML);
  const pushed = await cli(["push", file, "--name", "deck", "--team", "acme", "--json"]);
  assert(JSON.parse(pushed.stdout).notes?.length === 1, "push --json keeps the server's notes");
  const text = await cli(["push", file, "--name", "deck", "--team", "acme"]);
  assert(text.stderr.includes("Inputs is not enabled"), "push prints notes to stderr in text mode");
}

// comments and other commands accept links too
{
  const comments = await cli(["comments", `${SERVER}/acme/deck`, "--json"]);
  assert(comments.code === 0, `comments by link failed: ${comments.stderr}`);
}

// MCP tools
{
  const { mcpTool, MCP_TOOLS, loadState } = await import("../src/index.js");
  const names = MCP_TOOLS.map((t) => t.name);
  for (const n of ["get_artifact", "list_artifact_versions", "list_artifact_responses", "submit_artifact_response"]) assert(names.includes(n), `MCP exposes ${n}`);
  const state = loadState(cwd, ENV);
  const parsed = { flags: {} };
  const got = await mcpTool(state, parsed, "get_artifact", { artifact: "acme/deck" });
  assert(got.content.includes("deck v2"), "get_artifact returns text content inline");
  const bin = await mcpTool(state, parsed, "get_artifact", { artifact: "acme/brief", save_to: join(cwd, "mcp.pdf") });
  assert(bin.path && existsSync(join(cwd, "mcp.pdf")), "get_artifact saves binaries to save_to");
  const answered = await mcpTool(state, parsed, "submit_artifact_response", { artifact: "acme/deck", collection: "feedback", data: { stance: "agree" } });
  assert(answered.id === "res-1", "submit_artifact_response posts an answer");
  const versions = await mcpTool(state, parsed, "list_artifact_versions", { artifact: "acme/deck" });
  assert(versions.versions.length === 2, "list_artifact_versions lists versions");
}

console.log("read ok");
