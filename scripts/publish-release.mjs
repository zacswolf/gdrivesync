import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, extraEnv = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv
    }
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const version = packageJson.version;
const vsixPath = resolve(process.cwd(), `gdrivesync-${version}.vsix`);

requireEnv("VSCE_PAT");
requireEnv("OVSX_PAT");

run(npxCommand, ["@vscode/vsce", "package", "--no-dependencies", "-o", vsixPath]);
run(npmCommand, ["publish", "--provenance"]);
run(npxCommand, ["@vscode/vsce", "publish", "--packagePath", vsixPath]);
run(npxCommand, ["ovsx", "publish", "--packagePath", vsixPath, "-p", process.env.OVSX_PAT]);
