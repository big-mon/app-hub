import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TOOLS_PATH = path.join(ROOT, "tools.json");
const INDEX_TEMPLATE = path.join(ROOT, "index.html");
const HUB_ASSETS = ["styles.css"];
const TMP_DIR = path.join(ROOT, "_tmp");
const DIST_DIR = path.join(ROOT, "dist");

function run(cmd, options = {}) {
  execSync(cmd, { stdio: "inherit", shell: true, ...options });
}

function assertSafeSlug(slug) {
  if (!slug || typeof slug !== "string") {
    throw new Error("Invalid slug: missing or not a string");
  }
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid slug: ${slug}`);
  }
}

async function copyDir(src, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function buildIndex(tools) {
  let template = null;
  try {
    template = await fs.readFile(INDEX_TEMPLATE, "utf8");
  } catch {
    template = null;
  }

  const links = tools
    .map((tool) => {
      const label = tool.name || tool.title || tool.slug;
      const safeLabel = escapeHtml(label);
      const safeSlug = escapeHtml(tool.slug);
      return `        <li><a href="/${safeSlug}/">${safeLabel}<small>/${safeSlug}/</small></a></li>`;
    })
    .join("\n");

  const html =
    template && template.includes("<!-- TOOL_LINKS -->")
      ? template.replace("<!-- TOOL_LINKS -->", links)
      : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App Hub</title>
  </head>
  <body>
    <h1>App Hub</h1>
    <ul>
${links}
    </ul>
  </body>
</html>`;

  await fs.writeFile(path.join(DIST_DIR, "index.html"), html);

  for (const asset of HUB_ASSETS) {
    const src = path.join(ROOT, asset);
    const dest = path.join(DIST_DIR, asset);
    try {
      await fs.copyFile(src, dest);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

async function main() {
  const toolsRaw = await fs.readFile(TOOLS_PATH, "utf8");
  const tools = JSON.parse(toolsRaw);

  if (!Array.isArray(tools)) {
    throw new Error("tools.json must be an array");
  }

  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  for (const tool of tools) {
    const { slug, repo, type } = tool;
    assertSafeSlug(slug);
    if (!repo || !type) {
      throw new Error(`Tool entry missing repo/type for slug ${slug}`);
    }

    const toolTmp = path.join(TMP_DIR, slug);
    const toolDist = path.join(DIST_DIR, slug);

    console.log(`\n==> Cloning ${repo} -> ${toolTmp}`);
    run(`git clone --depth 1 ${repo} ${toolTmp}`);

    if (type === "static") {
      const srcRel = tool.src || ".";
      const srcPath = path.resolve(toolTmp, srcRel);
      console.log(`==> Copy static ${srcRel} -> ${toolDist}`);
      await copyDir(srcPath, toolDist);
      continue;
    }

    if (type === "node") {
      const buildCmd = tool.build;
      const outDir = tool.outDir;
      if (!buildCmd || !outDir) {
        throw new Error(`Node tool requires build and outDir for slug ${slug}`);
      }

      const env = { ...process.env };
      if (tool.basePathEnv) {
        env[tool.basePathEnv] = `/${slug}/`;
      }

      console.log(`==> Build ${slug}`);
      run(buildCmd, { cwd: toolTmp, env });

      const outPath = path.resolve(toolTmp, outDir);
      console.log(`==> Copy build ${outDir} -> ${toolDist}`);
      await copyDir(outPath, toolDist);
      continue;
    }

    throw new Error(`Unknown tool type: ${type} for slug ${slug}`);
  }

  await buildIndex(tools);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
