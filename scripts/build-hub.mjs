import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TOOLS_PATH = path.join(ROOT, "tools.json");
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
