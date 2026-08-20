import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB_ASSETS = ["styles.css"];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_PATH_PATTERN = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const COMMON_KEYS = new Set(["slug", "title", "name", "repo", "type"]);
const ALLOWED_KEYS_BY_TYPE = {
  static: new Set([...COMMON_KEYS, "src"]),
  node: new Set([...COMMON_KEYS, "build", "outDir", "basePathEnv"]),
};
const TYPE_SPECIFIC_KEYS = new Set([
  "src",
  "build",
  "outDir",
  "basePathEnv",
]);

export function isWithinRoot(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);

  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function resolveWithinRoot(root, candidate, fieldName = "path") {
  const resolved = path.resolve(root, candidate);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`${fieldName} must remain within the clone root: ${candidate}`);
  }
  return resolved;
}

export async function resolveRealDirectoryWithinRoot(root, candidate, fieldName = "path") {
  let realRoot;
  let realCandidate;
  try {
    [realRoot, realCandidate] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
    ]);
  } catch (cause) {
    throw new Error(
      `${fieldName} must resolve to an existing directory within the clone root: ${candidate}`,
      { cause },
    );
  }

  let candidateStats;
  try {
    candidateStats = await fs.stat(realCandidate);
  } catch (cause) {
    throw new Error(
      `${fieldName} must resolve to an existing directory within the clone root: ${candidate}`,
      { cause },
    );
  }

  if (!candidateStats.isDirectory() || !isWithinRoot(realRoot, realCandidate)) {
    throw new Error(
      `${fieldName} must resolve to an existing directory within the clone root: ${candidate}`,
    );
  }

  let realGitPath = null;
  try {
    realGitPath = await fs.realpath(path.join(realRoot, ".git"));
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw new Error(
        `${fieldName} must resolve to an existing directory within the clone root: ${candidate}`,
        { cause },
      );
    }
  }

  if (realGitPath && isWithinRoot(realGitPath, realCandidate)) {
    throw new Error(
      `${fieldName} must not resolve to the clone .git metadata path: ${candidate}`,
    );
  }

  return realCandidate;
}

function assertRelativePath(value, fieldName, slug) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    !isWithinRoot(".", path.resolve(".", value))
  ) {
    throw new Error(
      `Invalid ${fieldName} for ${slug}: expected a relative path within the clone root`,
    );
  }

  if (value.split("/").includes(".git")) {
    throw new Error(`Invalid ${fieldName} for ${slug}: path must not contain .git`);
  }
}

function assertRepo(repo, slug) {
  if (typeof repo !== "string" || repo.trim() !== repo) {
    throw new Error(
      `Invalid repo for ${slug}: expected a public HTTPS GitHub owner/repo URL`,
    );
  }

  let parsed;
  try {
    parsed = new URL(repo);
  } catch {
    throw new Error(
      `Invalid repo for ${slug}: expected a public HTTPS GitHub owner/repo URL`,
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !REPO_PATH_PATTERN.test(parsed.pathname)
  ) {
    throw new Error(
      `Invalid repo for ${slug}: expected a public HTTPS GitHub owner/repo URL`,
    );
  }
}

export function validateTools(tools) {
  if (!Array.isArray(tools)) {
    throw new Error("tools.json must be an array");
  }

  const slugs = new Set();
  for (const [index, tool] of tools.entries()) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error(`Tool at index ${index} must be an object`);
    }

    const { slug } = tool;
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      throw new Error(`Invalid slug: ${slug}. Use lowercase kebab-case.`);
    }
    if (slugs.has(slug)) {
      throw new Error(`Duplicate slug: ${slug}`);
    }
    slugs.add(slug);
  }

  for (const tool of tools) {
    const { slug } = tool;

    for (const field of ["title", "name"]) {
      if (Object.hasOwn(tool, field) && typeof tool[field] !== "string") {
        throw new Error(`Tool ${slug} field ${field} must be a string when present`);
      }
    }

    assertRepo(tool.repo, slug);

    if (tool.type !== "static" && tool.type !== "node") {
      throw new Error(`Invalid type for ${slug}: expected static or node`);
    }

    for (const key of Object.keys(tool)) {
      if (!ALLOWED_KEYS_BY_TYPE[tool.type].has(key)) {
        const typeContext = TYPE_SPECIFIC_KEYS.has(key)
          ? ` is not allowed for type ${tool.type}`
          : "";
        throw new Error(`Invalid key for ${slug}: ${key}${typeContext}`);
      }
    }

    if (tool.type === "static") {
      if (Object.hasOwn(tool, "src")) {
        assertRelativePath(tool.src, "src", slug);
      }
    } else {
      if (typeof tool.build !== "string" || tool.build.trim().length === 0) {
        throw new Error(`Node tool requires a nonempty build string for slug ${slug}`);
      }
      if (typeof tool.outDir !== "string" || tool.outDir.trim().length === 0) {
        throw new Error(`Node tool requires a nonempty outDir string for slug ${slug}`);
      }
      assertRelativePath(tool.outDir, "outDir", slug);
    }

    if (Object.hasOwn(tool, "basePathEnv")) {
      if (typeof tool.basePathEnv !== "string" || !ENV_NAME_PATTERN.test(tool.basePathEnv)) {
        throw new Error(
          `Invalid basePathEnv for ${slug}: expected an environment variable name`,
        );
      }
    }
  }

  return tools;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderIndex(template, tools) {
  const links = tools
    .map((tool) => {
      const label = tool.name || tool.title || tool.slug;
      const safeLabel = escapeHtml(label);
      const safeSlug = escapeHtml(tool.slug);
      return `        <li><a href="/${safeSlug}/">${safeLabel}<small>/${safeSlug}/</small></a></li>`;
    })
    .join("\n");

  return typeof template === "string" && template.includes("<!-- TOOL_LINKS -->")
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
}

async function assertPublishTreeIsSafe(source, fieldName, slug) {
  async function walk(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const candidate = path.join(directory, entry.name);
      const stats = await fs.lstat(candidate);

      if (stats.isSymbolicLink()) {
        throw new Error(
          "Cannot publish " +
            fieldName +
            " for " +
            slug +
            ": symbolic links are not allowed at " +
            relativePath,
        );
      }

      if (stats.isDirectory()) {
        await walk(candidate, relativePath);
      }
    }
  }

  await walk(source);
}

function shouldCopyPublishPath(source, candidate) {
  const relativePath = path.relative(source, candidate);
  if (relativePath === "") {
    return true;
  }

  return !relativePath.split(path.sep).includes(".git");
}

async function copyPublishTree(source, destination, { fieldName, slug }) {
  await assertPublishTreeIsSafe(source, fieldName, slug);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (candidate) => shouldCopyPublishPath(source, candidate),
  });
}

async function buildIndex(root, distDir, tools) {
  let template = null;
  try {
    template = await fs.readFile(path.join(root, "index.html"), "utf8");
  } catch {
    template = null;
  }

  await fs.writeFile(path.join(distDir, "index.html"), renderIndex(template, tools));

  for (const asset of HUB_ASSETS) {
    const src = path.join(root, asset);
    const dest = path.join(distDir, asset);
    try {
      await fs.copyFile(src, dest);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

function cloneRepository(repo, destination) {
  execFileSync("git", ["clone", "--depth", "1", repo, destination], {
    stdio: "inherit",
  });
}

function runTrackedBuild(buildCommand, options = {}) {
  // Trust boundary: build is a repository-maintained shell pipeline from the
  // manifest. Keep shell composition for package-manager commands such as
  // "pnpm install --frozen-lockfile && pnpm run build"; git clone above is
  // deliberately argv-based and never shares this shell execution path.
  execSync(buildCommand, { stdio: "inherit", shell: true, ...options });
}

async function buildHub(root = process.cwd()) {
  const toolsPath = path.join(root, "tools.json");
  const tmpDir = path.join(root, "_tmp");
  const distDir = path.join(root, "dist");
  const toolsRaw = await fs.readFile(toolsPath, "utf8");
  const tools = validateTools(JSON.parse(toolsRaw));

  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });

  for (const tool of tools) {
    const { slug, repo, type } = tool;
    const toolTmp = path.join(tmpDir, slug);
    const toolDist = path.join(distDir, slug);

    console.log(`\n==> Cloning ${repo} -> ${toolTmp}`);
    cloneRepository(repo, toolTmp);

    if (type === "static") {
      const srcRel = Object.hasOwn(tool, "src") ? tool.src : ".";
      const srcPath = resolveWithinRoot(toolTmp, srcRel, `src for ${slug}`);
      console.log(`==> Copy static ${srcRel} -> ${toolDist}`);
      const realSrcPath = await resolveRealDirectoryWithinRoot(
        toolTmp,
        srcPath,
        `src for ${slug}`,
      );
      await copyPublishTree(realSrcPath, toolDist, {
        fieldName: "src",
        slug,
      });
      continue;
    }

    const outPath = resolveWithinRoot(toolTmp, tool.outDir, `outDir for ${slug}`);
    const env = { ...process.env };
    if (Object.hasOwn(tool, "basePathEnv")) {
      env[tool.basePathEnv] = `/${slug}/`;
    }

    console.log(`==> Build ${slug}`);
    runTrackedBuild(tool.build, { cwd: toolTmp, env });

    console.log(`==> Copy build ${tool.outDir} -> ${toolDist}`);
    const realOutPath = await resolveRealDirectoryWithinRoot(
      toolTmp,
      outPath,
      `outDir for ${slug}`,
    );
    await copyPublishTree(realOutPath, toolDist, {
      fieldName: "outDir",
      slug,
    });
  }

  await buildIndex(root, distDir, tools);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  buildHub().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
