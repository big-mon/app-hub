# app-hub agent guide

## Source authorities

- `tools.json` is the sole source of truth for assembled tool subpaths, their human-crawlable root-list links, and generated tool sitemap entries. Root `/` canonical/site origin is owned by `SITE_ORIGIN` plus the root index template/build code, not `tools.json`.
- `package.json` is the source of truth for local commands and toolchain versions.
- `index.html` and `styles.css` define the hub page; preserve their appearance.
- `.github/workflows/` defines CI and deployment triggers and credential semantics.
- pnpm is the only package manager for this repository; do not add an npm lockfile.

## Build invariants

- Validate the complete manifest before creating `_tmp` or `dist`, cloning, or building.
- Slugs are unique lowercase kebab-case path segments.
- Repositories are public HTTPS GitHub owner/repo URLs without credentials, query, or hash.
- Static `src` and node `outDir` are relative paths contained by the clone root; `.` is valid.
- Published `src`/`outDir` subtrees must be symlink-free; `.git` directories and entries are excluded from publication.
- Git clone must use argv-based execution, never a shell-interpolated command.
- The manifest and registered node tool repositories, including their dependency/install/package/build scripts,
  are explicitly trusted registered code. `tool.build` remains a tracked-manifest shell contract;
  keep this trust boundary explicit and do not use it for the git clone.
- Cloudflare credentials are supplied only as deploy-action inputs and never as build environment variables.
- Keep HTML escaping, base-path injection, clean build directories, and hub asset copying intact.
- Generate `robots.txt` and `sitemap.xml` from the validated manifest; do not maintain a second public route inventory.

## Change and verification

| Change | Required verification |
| --- | --- |
| Manifest or validation | `pnpm test`; include invalid slug, URL, field, env, and path cases |
| Public inventory or root metadata | `pnpm test`; `pnpm run build`; inspect `dist/robots.txt`, `dist/sitemap.xml`, all listed URLs, and the root canonical |
| Build script or tool | `pnpm test`; `pnpm run build`; inspect all `dist/<slug>/index.html` |
| Workflow | Check action versions, triggers, variables/secrets, frozen install, and build command |
| Hub template/assets | Build and inspect links plus escaped labels; preserve the existing visual structure |
| Docs or notify example | Check literal bytes, Markdown links, and trigger/credential truth |

## Completion

- Every gate required by the applicable Change and verification matrix row must pass.
- Report commands run, artifacts checked, changed files, and unresolved risks.
- Keep `_tmp`, `dist`, and `node_modules` ignored; do not commit generated output.
- Do not commit, push, open or update PRs, merge, deploy, or mutate GitHub/Cloudflare unless the
  user gives explicit approval for that external action.
