// thing export --all / --team against a stub server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const home = await mkdtemp(join(tmpdir(), "thing-export-home-"));
const cwd = await mkdtemp(join(tmpdir(), "thing-export-cwd-"));
mkdirSync(join(home, "thing"));
writeFileSync(join(home, "thing", "config.json"), JSON.stringify({ server: "https://thing.test", activeAccount: "default", accounts: { default: { server: "https://thing.test", token: "tok" } } }));
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  seen.push({ path: url.pathname, auth: init.headers?.Authorization });
  if (url.pathname === "/api/v1/export" || url.pathname === "/t/acme/export") return new Response(ZIP, { headers: { "Content-Type": "application/zip" } });
  if (url.pathname === "/t/other/export") return new Response(JSON.stringify({ error: "Only team admins can export the team." }), { status: 403, headers: { "Content-Type": "application/json" } });
  return new Response("{}", { headers: { "Content-Type": "application/json" } });
};
const env = { ...process.env, XDG_CONFIG_HOME: home, THING_SERVER: "", THING_TOKEN: "" };
async function cli(args) {
  let stdout = "", stderr = "";
  const code = await run(args, { cwd, env, stdout: { write: (c) => { stdout += c; } }, stderr: { write: (c) => { stderr += c; } } });
  return { code, stdout, stderr };
}

const all = await cli(["export", "--all", "--output", "mine.zip"]);
assert(all.code === 0, `export --all failed: ${all.stderr}`);
assert(readFileSync(join(cwd, "mine.zip")).equals(ZIP), "export --all saves the zip");
assert(seen.some((s) => s.path === "/api/v1/export" && s.auth === "Bearer tok"), "export --all calls the API with the token");
const again = await cli(["export", "--all", "--output", "mine.zip"]);
assert(again.code !== 0 && again.stderr.includes("already exists"), "export never overwrites");
const team = await cli(["export", "--team", "acme"]);
assert(team.code === 0 && existsSync(join(cwd, `thing-export-acme-${new Date().toISOString().slice(0, 10)}.zip`)), "export --team saves the team zip");
const refused = await cli(["export", "--team", "other"]);
assert(refused.code !== 0 && refused.stderr.includes("Only team admins"), "a non-admin team export explains the refusal");
const bare = await cli(["export"]);
assert(bare.code !== 0 && bare.stderr.includes("Usage"), "export needs --all or --team");
console.log("export ok");
