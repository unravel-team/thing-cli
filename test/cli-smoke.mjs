import { readFileSync } from "node:fs";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const staleVersions = [...source.matchAll(/thing-(?:cli|mcp)\/(\d+\.\d+\.\d+)|version: "(\d+\.\d+\.\d+)"/g)]
  .map((match) => match[1] ?? match[2])
  .filter((version) => version !== pkg.version);
assert(staleVersions.length === 0, `version strings out of step with package.json ${pkg.version}: ${staleVersions.join(", ")}`);

let stdout = "";
let stderr = "";
const code = await run(["--help"], {
  cwd: process.cwd(),
  env: process.env,
  stdout: { write: (chunk) => { stdout += String(chunk); } },
  stderr: { write: (chunk) => { stderr += String(chunk); } }
});
assert(code === 0, `thing --help failed: ${stderr}`);
assert(stdout.includes("thing <command>"), "help should include the command usage");

console.log("CLI smoke passed");
