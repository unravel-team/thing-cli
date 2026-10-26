// thing projects / thing project ... / push --home, and the MCP project tools, against a stub server.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const home = await mkdtemp(join(tmpdir(), "thing-projects-home-"));
const cwd = await mkdtemp(join(tmpdir(), "thing-projects-cwd-"));
mkdirSync(join(home, "thing"));
writeFileSync(join(home, "thing", "config.json"), JSON.stringify({ server: "https://thing.test", activeAccount: "default", accounts: { default: { server: "https://thing.test", token: "tok" } } }));
writeFileSync(join(cwd, "index.html"), "<!doctype html><h1>overview</h1>");
const PROJECT = { id: "proj_1", slug: "q4", name: "Q4 launch", access: "restricted", team: "acme", archived: false, url: "https://thing.test/t/acme/p/q4" };
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  seen.push({ method: init.method || "GET", path: url.pathname, body });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/v1/projects" && (init.method || "GET") === "GET") return json({ projects: [PROJECT, { ...PROJECT, id: "proj_2", slug: "other", team: "beta", name: "Other" }] });
  if (url.pathname === "/api/v1/teams/acme/projects") return json({ project: { ...PROJECT, name: body.name, access: body.access } }, 201);
  if (url.pathname === "/api/v1/projects/proj_1" && (init.method || "GET") === "GET") return json({ project: PROJECT, members: [{ name: "Dana", role: "editor", guest: true }] });
  if (url.pathname === "/api/v1/projects/proj_1" && init.method === "PATCH") return json({ project: { ...PROJECT, ...body } });
  if (url.pathname === "/api/v1/projects/proj_1/members") return json({ ok: true }, 201);
  if (url.pathname.startsWith("/api/v1/projects/proj_1/members/")) return json({ ok: true });
  if (url.pathname === "/api/v1/artifacts") return json({ artifact: { id: "art_1", slug: "index", url: "https://thing.test/acme/index", team: "acme" }, version: { number: 1 } }, 201);
  if (url.pathname === "/api/v1/artifacts/by-path/acme/overview") return json({ artifact: { id: "art_9", slug: "overview", team: "acme", latestVersion: 1 }, versions: [] });
  return json({});
};
const env = { ...process.env, XDG_CONFIG_HOME: home, THING_SERVER: "", THING_TOKEN: "" };
async function cli(args) {
  let stdout = "", stderr = "";
  const code = await run(args, { cwd, env, stdout: { write: (c) => { stdout += c; } }, stderr: { write: (c) => { stderr += c; } } });
  return { code, stdout, stderr };
}
const last = (method, path) => [...seen].reverse().find((s) => s.method === method && s.path === path);

const listed = await cli(["projects", "--team", "acme", "--json"]);
assert(listed.code === 0, `projects failed: ${listed.stderr}`);
const projects = JSON.parse(listed.stdout).projects;
assert(projects.length === 1 && projects[0].slug === "q4", "projects --team filters to the workspace");

const created = await cli(["project", "create", "Q4 launch", "--team", "acme", "--restricted", "--brief", "Ship by week 3"]);
assert(created.code === 0, `project create failed: ${created.stderr}`);
const createBody = last("POST", "/api/v1/teams/acme/projects").body;
assert(createBody.name === "Q4 launch" && createBody.access === "restricted" && createBody.brief === "Ship by week 3", "project create sends name, access and brief");

const shown = await cli(["project", "show", "acme/q4"]);
assert(shown.code === 0 && shown.stdout.includes("Dana") && shown.stdout.includes("guest"), `project show lists members: ${shown.stdout}${shown.stderr}`);

assert((await cli(["project", "add", "acme/q4", "dana@client.example", "--role", "editor"])).code === 0, "project add works");
const added = last("POST", "/api/v1/projects/proj_1/members").body;
assert(added.email === "dana@client.example" && added.role === "editor", "project add sends email and role");

assert((await cli(["project", "remove", "acme/q4", "dana@client.example"])).code === 0, "project remove works");
assert(last("DELETE", `/api/v1/projects/proj_1/members/${encodeURIComponent("dana@client.example")}`), "project remove calls DELETE with the email");

assert((await cli(["project", "set", "acme/q4", "--access", "open", "--archive"])).code === 0, "project set works");
const patch = last("PATCH", "/api/v1/projects/proj_1").body;
assert(patch.access === "open" && patch.archived === true, "project set sends access and archived");

assert((await cli(["project", "set", "acme/q4", "--home", "acme/overview"])).code === 0, "project set --home works");
assert(last("PATCH", "/api/v1/projects/proj_1").body.home === "art_9", "project set --home resolves the artifact to its id");

assert((await cli(["project", "set", "acme/q4", "--home", "none"])).code === 0, "project set --home none works");
assert(last("PATCH", "/api/v1/projects/proj_1").body.home === null, "--home none clears the page");

const missing = await cli(["project", "show", "acme/nope"]);
assert(missing.code !== 0 && missing.stderr.includes("not found"), "an unknown project explains itself");

const pushed = await cli(["push", join(cwd, "index.html"), "--team", "acme", "--project", "q4", "--home"]);
assert(pushed.code === 0, `push --home failed: ${pushed.stderr}`);
const pushBody = last("POST", "/api/v1/artifacts").body;
assert(pushBody.home === true && pushBody.project === "q4", "push --home asks for the project page");
await cli(["push", join(cwd, "index.html"), "--team", "acme"]);
assert(last("POST", "/api/v1/artifacts").body.home === undefined, "a plain push does not set the page");

// MCP tools
let out = "";
const lines = [
  { jsonrpc: "2.0", id: 1, method: "tools/list" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_project_member", arguments: { project: "acme/q4", email: "sam@client.example", role: "viewer" } } }
].map((m) => JSON.stringify(m)).join("\n") + "\n";
const { Readable } = await import("node:stream");
await run(["mcp"], { cwd, env, stdin: Readable.from([lines]), stdout: { write: (c) => { out += c; } }, stderr: { write: () => {} } });
const replies = out.trim().split("\n").map((l) => JSON.parse(l));
const tools = replies.find((r) => r.id === 1).result.tools.map((t) => t.name);
for (const name of ["list_projects", "create_project", "get_project", "update_project", "add_project_member", "remove_project_member"]) assert(tools.includes(name), `MCP offers ${name}`);
assert(replies.find((r) => r.id === 1).result.tools.find((t) => t.name === "push_artifact").inputSchema.properties.home, "push_artifact takes home");
assert(!replies.find((r) => r.id === 2).result.isError, "add_project_member works over MCP");
assert(last("POST", "/api/v1/projects/proj_1/members").body.email === "sam@client.example", "MCP add_project_member sends the email");
console.log("projects ok");
