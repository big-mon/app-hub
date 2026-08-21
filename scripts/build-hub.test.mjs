import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "build-hub.mjs");
const VALID_REPO = "https://github.com/example/app";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const hub = await import(pathToFileURL(SCRIPT_PATH).href);

function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

async function runBuildWithTools(tools) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-build-"));
  await writeFile(path.join(tempRoot, "tools.json"), `${JSON.stringify(tools)}\n`);
  await writeFile(path.join(tempRoot, "index.html"), "<!-- TOOL_LINKS -->\n");
  await writeFile(path.join(tempRoot, "styles.css"), "");

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: tempRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 5_000,
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const tempDirCreated = await exists(path.join(tempRoot, "_tmp"));
  const distDirCreated = await exists(path.join(tempRoot, "dist"));
  await rm(tempRoot, { recursive: true, force: true });

  return { result, output, tempDirCreated, distDirCreated };
}

function staticTool(overrides = {}) {
  return {
    slug: "sample-static-tool",
    repo: VALID_REPO,
    type: "static",
    src: "public",
    ...overrides,
  };
}

function nodeTool(overrides = {}) {
  return {
    slug: "sample-node-tool",
    repo: VALID_REPO,
    type: "node",
    build: "pnpm run build",
    outDir: "dist",
    basePathEnv: "BASE_PATH",
    ...overrides,
  };
}

async function runFixtureBuild(tools, fakeGitScript, extraEnv = {}, timeout = 5_000) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-fixture-"));
  const fakeBin = path.join(tempRoot, "bin");
  const fakeGit = path.join(fakeBin, "git");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeGit, fakeGitScript);
  await chmod(fakeGit, 0o755);
  await writeFile(path.join(tempRoot, "tools.json"), `${JSON.stringify(tools)}\n`);
  await writeFile(path.join(tempRoot, "index.html"), "<!-- TOOL_LINKS -->\n");
  await writeFile(path.join(tempRoot, "styles.css"), "");

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
    timeout,
  });

  return {
    tempRoot,
    result,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

test("the two existing static tools remain in the manifest", async () => {
  const tools = JSON.parse(await readFile(path.join(REPO_ROOT, "tools.json"), "utf8"));
  const slugs = tools.map((tool) => tool.slug);

  assert.deepEqual(slugs.slice(0, 2), [
    "amazon-link-cleaner-cloudflare",
    "sorting-visualizer-web",
  ]);
});

test("the image compressor registration has the requested node-tool contract", async () => {
  const tools = JSON.parse(await readFile(path.join(REPO_ROOT, "tools.json"), "utf8"));
  const imageTool = tools.find((tool) => tool.slug === "image-compressor-web");

  assert.deepEqual(imageTool, {
    slug: "image-compressor-web",
    title: "ローカルで画像をトリミング・圧縮",
    repo: "https://github.com/big-mon/image-compressor-web",
    type: "node",
    build: "pnpm --ignore-workspace install --frozen-lockfile && pnpm run build",
    outDir: "dist",
    basePathEnv: "BASE_PATH",
  });
});

test("the repository owns a pinned Wrangler and gates CI on its availability", async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const workspaceSource = (await readFile(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8").catch(() => ""))
    .replace(/\r\n?/g, "\n");
  const ciSource = await readFile(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const installIndex = ciSource.indexOf("- name: Install dependencies");
  const wranglerIndex = ciSource.indexOf("- name: Verify Wrangler availability");
  const testIndex = ciSource.indexOf("- name: Test");
  const hasWranglerAvailabilityGate =
    /- name: Verify Wrangler availability\s*\n\s+run: pnpm exec wrangler --version/.test(ciSource) &&
    installIndex >= 0 &&
    wranglerIndex > installIndex &&
    testIndex > wranglerIndex;

  assert.equal(workspaceSource, "allowBuilds:\n  esbuild: true\n  workerd: true\n");
  assert.equal(packageJson.devDependencies?.wrangler, "4.124.0");
  assert.equal(hasWranglerAvailabilityGate, true);
});

test("the current static and node shapes pass manifest validation", () => {
  assert.doesNotThrow(() => hub.validateTools([staticTool(), nodeTool()]));
});

test("validation rejects unsafe and duplicate slugs", () => {
  assert.throws(
    () => hub.validateTools([staticTool({ slug: "Unsafe/slug" })]),
    /slug/i,
  );
  assert.throws(
    () => hub.validateTools([staticTool({ slug: "same-slug" }), nodeTool({ slug: "same-slug" })]),
    /duplicate/i,
  );
});

test("validation rejects invalid repositories and required fields", () => {
  assert.throws(() => hub.validateTools([staticTool({ repo: "not-a-github-url" })]), /github/i);
  assert.throws(() => hub.validateTools([staticTool({ type: "other" })]), /type/i);
  assert.throws(() => hub.validateTools([staticTool({ title: 42 })]), /title/i);
  assert.throws(() => hub.validateTools([staticTool({ name: null })]), /name/i);
  assert.throws(() => hub.validateTools([staticTool({ src: "../outside" })]), /src/i);
  assert.throws(() => hub.validateTools([staticTool({ src: "/tmp/outside" })]), /src/i);
  assert.throws(() => hub.validateTools([nodeTool({ build: "" })]), /build/i);
  assert.throws(() => hub.validateTools([nodeTool({ outDir: "" })]), /outDir/i);
  assert.throws(() => hub.validateTools([nodeTool({ outDir: "../outside" })]), /outDir/i);
  assert.throws(() => hub.validateTools([nodeTool({ outDir: "/tmp/outside" })]), /outDir/i);
});

test("validation rejects .git publication roots lexically", () => {
  assert.throws(
    () => hub.validateTools([staticTool({ src: ".git" })]),
    /Invalid src for sample-static-tool:.*\.git/i,
  );
  assert.throws(
    () => hub.validateTools([nodeTool({ outDir: ".git" })]),
    /Invalid outDir for sample-node-tool:.*\.git/i,
  );
});

test("validation rejects unknown and type-inapplicable keys with slug/key diagnostics", () => {
  const cases = [
    { tool: staticTool({ src: ".", scr: "public" }), key: "scr" },
    { tool: staticTool({ src: ".", build: "pnpm run build" }), key: "build" },
    { tool: staticTool({ src: ".", outDir: "dist" }), key: "outDir" },
    { tool: staticTool({ src: ".", basePathEnv: "BASE_PATH" }), key: "basePathEnv" },
    { tool: nodeTool({ src: "public", outDir: ".", build: "true" }), key: "src" },
    { tool: staticTool({ src: ".", arbitrary: true }), key: "arbitrary" },
  ];

  for (const { tool, key } of cases) {
    assert.throws(
      () => hub.validateTools([tool]),
      new RegExp(`Invalid key for ${tool.slug}: ${key}`),
    );
  }
});

test("validation rejects invalid environment variable names", () => {
  assert.throws(
    () => hub.validateTools([nodeTool({ basePathEnv: "BASE-PATH" })]),
    /environment/i,
  );
  assert.throws(
    () => hub.validateTools([nodeTool({ basePathEnv: "1BASE_PATH" })]),
    /environment/i,
  );
});

test("containment allows the clone root and rejects traversal, absolute escapes, and prefix traps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-hub-root-"));
  try {
    assert.equal(hub.isWithinRoot(root, root), true);
    assert.equal(hub.isWithinRoot(root, path.join(root, "dist")), true);
    assert.equal(hub.isWithinRoot(root, path.resolve(root, "../outside")), false);
    assert.equal(hub.isWithinRoot(root, path.join(root, "-sibling", "asset")), true);
    assert.equal(hub.isWithinRoot(root, `${root}-sibling/asset`), false);
    assert.equal(hub.isWithinRoot(root, path.resolve(root, "/definitely-outside")), false);

    assert.equal(hub.resolveWithinRoot(root, ".", "src"), root);
    assert.equal(hub.resolveWithinRoot(root, "dist", "outDir"), path.join(root, "dist"));
    assert.throws(() => hub.resolveWithinRoot(root, "../outside", "src"), /outside/i);
    assert.throws(
      () => hub.resolveWithinRoot(root, path.resolve(root, "../outside"), "outDir"),
      /outside/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("realpath containment allows an inside directory symlink and rejects missing or non-directory paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-hub-real-root-"));
  try {
    const target = path.join(root, "public-target");
    const link = path.join(root, "public-link");
    const file = path.join(root, "file");
    await mkdir(target);
    await symlink(target, link, "dir");
    await writeFile(file, "not a directory");

    assert.equal(
      await hub.resolveRealDirectoryWithinRoot(root, link, "src for sample-static-tool"),
      await realpath(target),
    );
    await assert.rejects(
      hub.resolveRealDirectoryWithinRoot(root, file, "src for sample-static-tool"),
      /src for sample-static-tool.*directory within the clone root/i,
    );
    await assert.rejects(
      hub.resolveRealDirectoryWithinRoot(root, path.join(root, "missing"), "outDir for sample-node-tool"),
      /outDir for sample-node-tool.*directory within the clone root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest preflight rejects .git roots before filesystem mutation", async () => {
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir } from "node:fs/promises";

await mkdir(process.argv.at(-1), { recursive: true });
`;
  const cases = [
    {
      tools: [staticTool({ src: ".git" })],
      error: /Invalid src for sample-static-tool:.*\.git/i,
    },
    {
      tools: [nodeTool({ build: "true", outDir: ".git" })],
      error: /Invalid outDir for sample-node-tool:.*\.git/i,
    },
    {
      tools: [staticTool({ src: ".", scr: "public" })],
      error: /Invalid key for sample-static-tool: scr/i,
    },
    {
      tools: [staticTool({ src: ".", build: "true" })],
      error: /Invalid key for sample-static-tool: build/i,
    },
    {
      tools: [staticTool({ src: ".", outDir: "." })],
      error: /Invalid key for sample-static-tool: outDir/i,
    },
    {
      tools: [staticTool({ src: ".", basePathEnv: "BASE_PATH" })],
      error: /Invalid key for sample-static-tool: basePathEnv/i,
    },
    {
      tools: [nodeTool({ src: "public", outDir: ".", build: "true" })],
      error: /Invalid key for sample-node-tool: src/i,
    },
    {
      tools: [staticTool({ src: ".", arbitrary: true })],
      error: /Invalid key for sample-static-tool: arbitrary/i,
    },
  ];

  for (const testCase of cases) {
    const fixture = await runFixtureBuild(testCase.tools, fakeGitScript);
    try {
      assert.notEqual(fixture.result.status, 0, fixture.output);
      assert.match(fixture.output, testCase.error);
      assert.equal(await exists(path.join(fixture.tempRoot, "_tmp")), false);
      assert.equal(await exists(path.join(fixture.tempRoot, "dist")), false);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  }
});

test("static src symlink resolving outside the clone root is rejected before copy", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-static-outside-"));
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(destination, { recursive: true });
await symlink(process.env.APP_HUB_OUTSIDE, path.join(destination, "public"), "dir");
`;

  try {
    fixture = await runFixtureBuild(
      [staticTool()],
      fakeGitScript,
      { APP_HUB_OUTSIDE: outsideRoot },
    );
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(fixture.output, /src for sample-static-tool.*directory within the clone root/i);
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("node outDir symlink resolving outside the clone root is rejected before copy", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-node-outside-"));
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(destination, { recursive: true });
await writeFile(
  path.join(destination, "build.mjs"),
  [
    'import { symlink } from "node:fs/promises";',
    'import path from "node:path";',
    'await symlink(process.env.APP_HUB_OUTSIDE, path.join(process.cwd(), "dist"), "dir");',
  ].join("\\n"),
);
`;

  try {
    fixture = await runFixtureBuild(
      [nodeTool({ build: "node build.mjs" })],
      fakeGitScript,
      { APP_HUB_OUTSIDE: outsideRoot },
    );
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(fixture.output, /outDir for sample-node-tool.*directory within the clone root/i);
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-node-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("static src top-level symlink resolving to clone .git is rejected at runtime", async () => {
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(path.join(destination, ".git"), { recursive: true });
await symlink(".git", path.join(destination, "public"), "dir");
`;

  try {
    fixture = await runFixtureBuild([staticTool()], fakeGitScript);
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(fixture.output, /src for sample-static-tool.*(?:\.git|git metadata)/i);
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("node outDir build-created symlink resolving to clone .git is rejected at runtime", async () => {
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(path.join(destination, ".git"), { recursive: true });
await writeFile(
  path.join(destination, "build.mjs"),
  [
    'import { symlink } from "node:fs/promises";',
    'import path from "node:path";',
    'await symlink(".git", path.join(process.cwd(), "dist"), "dir");',
  ].join("\\n"),
);
`;

  try {
    fixture = await runFixtureBuild(
      [nodeTool({ build: "node build.mjs" })],
      fakeGitScript,
    );
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(fixture.output, /outDir for sample-node-tool.*(?:\.git|git metadata)/i);
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-node-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("static src rejects nested symlinks to outside directories and files before publish", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-static-nested-outside-"));
  const outsideFile = path.join(outsideRoot, "outside.txt");
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
const assets = path.join(destination, "public", "assets");
await mkdir(assets, { recursive: true });
await writeFile(path.join(destination, "public", "index.html"), "fixture static\\n");
await symlink(process.env.APP_HUB_OUTSIDE_DIR, path.join(assets, "outside-dir"), "dir");
await symlink(process.env.APP_HUB_OUTSIDE_FILE, path.join(assets, "outside-file.txt"), "file");
`;

  try {
    await writeFile(outsideFile, "outside file\\n");
    fixture = await runFixtureBuild(
      [staticTool()],
      fakeGitScript,
      {
        APP_HUB_OUTSIDE_DIR: outsideRoot,
        APP_HUB_OUTSIDE_FILE: outsideFile,
      },
    );
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(
      fixture.output,
      /src for sample-static-tool.*assets[\\/]outside-(?:dir|file)/i,
    );
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("node outDir rejects nested symlinks to outside directories and files before publish", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "app-hub-node-nested-outside-"));
  const outsideFile = path.join(outsideRoot, "outside.txt");
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(destination, { recursive: true });
await writeFile(
  path.join(destination, "build.mjs"),
  [
    'import { mkdir, symlink, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    'const assets = path.join(process.cwd(), "dist", "assets");',
    'await mkdir(assets, { recursive: true });',
    'await writeFile(path.join(process.cwd(), "dist", "index.html"), "fixture node\\\\n");',
    'await symlink(process.env.APP_HUB_OUTSIDE_DIR, path.join(assets, "outside-dir"), "dir");',
    'await symlink(process.env.APP_HUB_OUTSIDE_FILE, path.join(assets, "outside-file.txt"), "file");',
  ].join("\\n"),
);
`;

  try {
    await writeFile(outsideFile, "outside file\\n");
    fixture = await runFixtureBuild(
      [nodeTool({ build: "node build.mjs" })],
      fakeGitScript,
      {
        APP_HUB_OUTSIDE_DIR: outsideRoot,
        APP_HUB_OUTSIDE_FILE: outsideFile,
      },
    );
    assert.notEqual(fixture.result.status, 0, fixture.output);
    assert.match(
      fixture.output,
      /outDir for sample-node-tool.*assets[\\/]outside-(?:dir|file)/i,
    );
    assert.equal(await exists(path.join(fixture.tempRoot, "dist", "sample-node-tool")), false);
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("static src dot copies ordinary root artifacts but excludes the git directory", async () => {
  let fixture;
  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = process.argv.at(-1);
await mkdir(path.join(destination, ".git"), { recursive: true });
await writeFile(path.join(destination, ".git", "config"), "fixture git metadata\\n");
await mkdir(path.join(destination, "assets"), { recursive: true });
await writeFile(path.join(destination, "index.html"), "fixture root\\n");
await writeFile(path.join(destination, "assets", "app.js"), "fixture asset\\n");
`;

  try {
    fixture = await runFixtureBuild(
      [staticTool({ src: "." })],
      fakeGitScript,
    );
    assert.equal(fixture.result.status, 0, fixture.output);
    assert.equal(
      await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool", "index.html")),
      true,
    );
    assert.equal(
      await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool", "assets", "app.js")),
      true,
    );
    assert.equal(
      await exists(path.join(fixture.tempRoot, "dist", "sample-static-tool", ".git")),
      false,
    );
  } finally {
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("index rendering escapes labels and preserves name/title fallback behavior", () => {
  const html = hub.renderIndex("<main><!-- TOOL_LINKS --></main>", [
    { slug: "escaped-tool", name: '<img src=x onerror="boom">' },
    { slug: "title-tool", title: "表示タイトル" },
  ]);

  assert.match(html, /&lt;img src=x onerror=&quot;boom&quot;&gt;/);
  assert.match(html, /href="\/escaped-tool\/"/);
  assert.match(html, /href="\/title-tool\/">表示タイトル<small>/);
});

test("robots rendering points crawlers to the absolute sitemap", () => {
  assert.equal(
    hub.renderRobots(),
    "User-agent: *\nAllow: /\n\nSitemap: https://app.damonge.com/sitemap.xml\n",
  );
});

test("sitemap rendering emits one minimal canonical URL per validated tool", () => {
  const tools = [
    staticTool({ slug: "first-tool" }),
    nodeTool({ slug: "second-tool" }),
  ];
  hub.validateTools(tools);

  const xml = hub.renderSitemap(tools);
  const expectedLocs = [
    "https://app.damonge.com/",
    "https://app.damonge.com/first-tool/",
    "https://app.damonge.com/second-tool/",
  ];
  const expectedXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...expectedLocs.map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`),
    "</urlset>",
    "",
  ].join("\n");

  assert.deepEqual(sitemapLocs(xml), expectedLocs);
  assert.equal(xml, expectedXml);
  assert.doesNotMatch(xml, /<(?:lastmod|priority|changefreq)>/);
});

test("root index metadata identifies the canonical site and describes the hub", async () => {
  const rootHtml = await readFile(path.join(REPO_ROOT, "index.html"), "utf8");

  assert.match(
    rootHtml,
    /<link rel="canonical" href="https:\/\/app\.damonge\.com\/" \/>/,
  );
  assert.match(rootHtml, /<title>App Hub \| ミニツール集<\/title>/);
  const description = rootHtml.match(
    /<meta\s+name="description"\s+content="([^"]+)"\s*\/>/s,
  )?.[1];
  assert.ok(description && description.trim().length > 10);
  assert.match(description, /ミニツール|ツール/);

  const externalAnchors = [...rootHtml.matchAll(/<a\b[^>]*>/gi)]
    .map(([anchor]) => anchor)
    .filter((anchor) => /\bhref\s*=\s*["']https?:\/\//i.test(anchor));
  assert.ok(externalAnchors.length > 0, "root index should contain an external anchor");
  for (const anchor of externalAnchors) {
    assert.match(anchor, /\btarget\s*=\s*["']_blank["']/i);
    assert.match(
      anchor,
      /\brel\s*=\s*["'](?=[^"']*\bnoopener\b)(?=[^"']*\bnoreferrer\b)[^"']*["']/i,
    );
  }
  assert.doesNotMatch(rootHtml, /name="keywords"/i);
});

test("preflight validation runs before filesystem mutation for unsafe manifests", async () => {
  const cases = [
    {
      tools: [staticTool({ slug: "../escape", repo: "not-a-repo" })],
      error: /slug/i,
    },
    {
      tools: [staticTool({ slug: "same-slug", repo: "not-a-repo" }), nodeTool({ slug: "same-slug", repo: "not-a-repo" })],
      error: /duplicate/i,
    },
    {
      tools: [staticTool({ repo: "not-a-repo" })],
      error: /github/i,
    },
    {
      tools: [staticTool({ src: "../outside" })],
      error: /src/i,
    },
    {
      tools: [nodeTool({ build: "" })],
      error: /build/i,
    },
    {
      tools: [nodeTool({ basePathEnv: "BAD-NAME" })],
      error: /environment/i,
    },
  ];

  for (const testCase of cases) {
    const outcome = await runBuildWithTools(testCase.tools);
    assert.notEqual(outcome.result.status, 0, outcome.output);
    assert.match(outcome.output, testCase.error);
    assert.equal(outcome.tempDirCreated, false, outcome.output);
    assert.equal(outcome.distDirCreated, false, outcome.output);
  }
});

test("offline fixture orchestration copies static tools and a base-path node tool", async (t) => {
  let fixture;
  let server;

  const fakeGitScript = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const repo = args.at(-2);
const destination = args.at(-1);
await mkdir(destination, { recursive: true });

if (repo.includes("amazon-link-cleaner-cloudflare") || repo.includes("sorting-visualizer-web")) {
  await mkdir(path.join(destination, "public"), { recursive: true });
  await writeFile(path.join(destination, "public", "index.html"), "<p>fixture static</p>\\n");
} else if (repo.includes("image-compressor-web")) {
  await writeFile(
    path.join(destination, "package.json"),
    JSON.stringify({
      name: "fixture-image-compressor-web",
      private: true,
      type: "module",
      scripts: { build: "node build.mjs" },
    }),
  );
  await writeFile(
    path.join(destination, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\\n\\nsettings:\\n  autoInstallPeers: true\\n  excludeLinksFromLockfile: false\\n\\nimporters:\\n\\n  .: {}\\n",
  );
  await writeFile(
    path.join(destination, "build.mjs"),
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'const base = process.env.BASE_PATH;',
      'if (base !== "/image-compressor-web/") throw new Error("unexpected BASE_PATH: " + base);',
      'await mkdir("dist/assets", { recursive: true });',
      'await writeFile("dist/assets/app.js", "fixture js");',
      'await writeFile("dist/assets/app.css", "fixture css");',
      'await writeFile("dist/assets/worker.js", "fixture worker");',
      'await writeFile("dist/favicon.svg", "<svg></svg>");',
      'await writeFile("dist/index.html", "<link rel=stylesheet href=" + base + "assets/app.css><script src=" + base + "assets/app.js></script><script src=" + base + "assets/worker.js></script><link rel=icon href=" + base + "favicon.svg>");',
    ].join("\\n"),
  );
} else {
  throw new Error("unexpected fixture repository: " + repo);
}
`;

  try {
    const tools = JSON.parse(await readFile(path.join(REPO_ROOT, "tools.json"), "utf8"));
    fixture = await runFixtureBuild(tools, fakeGitScript, {}, 30_000);
    const { tempRoot, result, output } = fixture;
    assert.equal(result.status, 0, output);

    const hubHtml = await readFile(path.join(tempRoot, "dist", "index.html"), "utf8");
    assert.equal(
      await readFile(path.join(tempRoot, "dist", "robots.txt"), "utf8"),
      "User-agent: *\nAllow: /\n\nSitemap: https://app.damonge.com/sitemap.xml\n",
    );
    const sitemap = await readFile(path.join(tempRoot, "dist", "sitemap.xml"), "utf8");
    const sitemapUrls = sitemapLocs(sitemap);
    assert.deepEqual(sitemapUrls, [
      "https://app.damonge.com/",
      "https://app.damonge.com/amazon-link-cleaner-cloudflare/",
      "https://app.damonge.com/sorting-visualizer-web/",
      "https://app.damonge.com/image-compressor-web/",
    ]);
    for (const relativePath of [
      "index.html",
      "amazon-link-cleaner-cloudflare/index.html",
      "sorting-visualizer-web/index.html",
      "image-compressor-web/index.html",
    ]) {
      assert.equal(await exists(path.join(tempRoot, "dist", relativePath)), true, relativePath);
    }
    for (const slug of [
      "amazon-link-cleaner-cloudflare",
      "sorting-visualizer-web",
      "image-compressor-web",
    ]) {
      assert.match(hubHtml, new RegExp(`href="/${slug}/"`));
    }

    const imageHtml = await readFile(
      path.join(tempRoot, "dist", "image-compressor-web", "index.html"),
      "utf8",
    );
    assert.match(imageHtml, /\/image-compressor-web\/assets\/app\.js/);
    for (const asset of ["assets/app.js", "assets/app.css", "assets/worker.js", "favicon.svg"]) {
      assert.equal(
        await exists(path.join(tempRoot, "dist", "image-compressor-web", asset)),
        true,
      );
    }

    const distRoot = path.join(tempRoot, "dist");
    server = createServer(async (request, response) => {
      try {
        const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const relativePath =
          requestPath === "/"
            ? "index.html"
            : requestPath.endsWith("/")
              ? `${requestPath.slice(1)}index.html`
              : requestPath.slice(1);
        const target = path.resolve(distRoot, decodeURIComponent(relativePath));
        if (!hub.isWithinRoot(distRoot, target)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.end(await readFile(target));
      } catch {
        response.statusCode = 404;
        response.end();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    } catch (err) {
      if (err?.code === "EACCES" || err?.code === "EPERM") {
        t.skip("the execution sandbox does not allow loopback listeners");
        return;
      }
      throw err;
    }
    const { port } = server.address();
    for (const requestPath of [
      "/",
      "/amazon-link-cleaner-cloudflare/",
      "/sorting-visualizer-web/",
      "/image-compressor-web/",
      "/image-compressor-web/assets/app.js",
      "/image-compressor-web/assets/app.css",
      "/image-compressor-web/assets/worker.js",
      "/image-compressor-web/favicon.svg",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${requestPath}`);
      assert.equal(response.status, 200, requestPath);
    }
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (fixture) await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});
