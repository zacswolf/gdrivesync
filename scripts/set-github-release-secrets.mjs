import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const ENV_FILES = [".env", ".env.local"].map((name) => resolve(ROOT, name));
const repo = process.argv.includes("--repo")
  ? process.argv[process.argv.indexOf("--repo") + 1]
  : execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: ROOT,
      encoding: "utf8"
    }).trim();

function parseEnvFile(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function loadEnvValues() {
  const values = new Map();
  for (const filePath of ENV_FILES) {
    if (!existsSync(filePath)) {
      continue;
    }
    const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
    for (const [key, value] of parsed.entries()) {
      if (!values.has(key)) {
        values.set(key, value);
      }
    }
  }
  return values;
}

function requireToken(name, envValues) {
  const value = (process.env[name] || envValues.get(name) || "").trim();
  if (value.length <= 5) {
    throw new Error(`Missing or too-short ${name}. Put it in .env/.env.local or export it before running this script.`);
  }
  return value;
}

function setSecret(name, value) {
  execFileSync("gh", ["secret", "set", name, "--repo", repo], {
    cwd: ROOT,
    input: value,
    stdio: ["pipe", "inherit", "inherit"]
  });
  console.log(`Set GitHub secret ${name} for ${repo}.`);
}

const envValues = loadEnvValues();
const vscePat = requireToken("VSCE_PAT", envValues);
setSecret("VSCE_PAT", vscePat);

const ovsxPat = (process.env.OVSX_PAT || envValues.get("OVSX_PAT") || "").trim();
if (ovsxPat.length > 5) {
  setSecret("OVSX_PAT", ovsxPat);
} else {
  console.log("Skipped OVSX_PAT because it was not present.");
}
