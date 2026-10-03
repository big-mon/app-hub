# app-hub

複数のミニツール（別々のGitHubリポジトリ）を1つのCloudflare Pagesプロジェクトに集約し、サブパスで配信する公開用ハブです。各ツールの実装や公開はこのリポジトリでは行わず、`tools.json` の定義から `dist/<slug>/` を作成します。

## ローカル開発

`package.json` に定義した Node.js 24 LTS（24.21.0 以上の 24.x）と pnpm 12.4.1 を使います。CIとDeployも同じバージョンを使います。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

まとめて実行する場合は `pnpm check` を使います。ビルドは各ツールをcloneしてビルドし、`dist/index.html` と `dist/<slug>/` を作成します。`dist` と `_tmp` は生成物のためGit管理しません。

## クロール用ファイルとSEOの基礎

`pnpm run build` は、検証済みの `tools.json` から人間向けのrootリンクと同じslugを使って、rootの `dist/robots.txt` と `dist/sitemap.xml` を生成します。公開ツールsubpathの在庫は `tools.json` で管理し、root `/` は別管理です。別のroute一覧は持ちません。rootのtitle・description・canonicalもテンプレートから生成します。

信頼できない更新日時や優先度などのメタデータは作らず、meta keywords、隠しリンク、キーワード詰め込み、doorway page、cloaking、偽の評価、推測に基づくJSON-LDなどのSEOハックも追加しません。方針の一次資料は [Googleのサイトマップガイド](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)、[robots.txtガイド](https://developers.google.com/search/docs/crawling-indexing/robots/intro)、[スパムポリシー](https://developers.google.com/search/docs/essentials/spam-policies) を参照してください。

## tools.json にツールを追加

`tools.json` に対象ツールを列挙します。

- `type=static`: `src`（省略時はリポジトリroot）を `dist/<slug>/` にコピーします
- `type=node`: `build` を実行し、`outDir` を `dist/<slug>/` にコピーします
- `basePathEnv` を指定すると、ビルド時に `/<slug>/` を環境変数へ渡します
- `src` と `outDir` はclone rootの外へ出ない相対pathにします
- 公開する `src`/`outDir` の配下はシンボリックリンクを拒否し、`.git` のディレクトリ/エントリは除外します（`src: "."` も利用できます）
- `_tmp` 配下にcloneするpnpmのnodeツールは、`NPM_CONFIG_WORKSPACE_DIR="$PWD"` で子リポジトリをworkspace解決の起点にし、installとrunの両方に `--ignore-workspace` を付けます。pnpm 12の起動時の版選択も含め、子の `packageManager` に固定したpnpmを使います。子のlockfileを書き換えずにfrozen installします
- manifestに登録したnodeリポジトリと依存関係・install/buildスクリプトは、登録時に信頼するコードです。`build` は追跡対象manifestのshell契約として実行します。

nodeツールの例:

```json
{
  "slug": "image-compressor-web",
  "title": "ローカルで画像をトリミング・圧縮",
  "repo": "https://github.com/big-mon/image-compressor-web",
  "type": "node",
  "build": "export NPM_CONFIG_WORKSPACE_DIR=\"$PWD\" && pnpm --ignore-workspace install --frozen-lockfile && pnpm --ignore-workspace run build",
  "outDir": "dist",
  "basePathEnv": "BASE_PATH"
}
```

## GitHub Actions

CIは `pull_request` と `main` への `push` で起動し、依存関係をfrozen installした後にWranglerの利用可能性を確認し、testとbuildを実行します。CIではCloudflareのSecretsを使わず、デプロイもしません。

Deployは `main` への `push`、手動の `workflow_dispatch`、または `tool_updated` 型の `repository_dispatch` で起動します。各ツールをcloneしてhubをビルドし、Cloudflare PagesへDirect Uploadします。

### ツール更新通知

各ツールリポジトリの `main` へのpush時に、ツール側Workflowからapp-hubへ `repository_dispatch` を1回送ります。`client_payload` は更新元の `repo` と `sha` だけで、ツール側から直接デプロイはしません。

Fine-grained PATはRepository accessを `big-mon/app-hub` だけに限定し、Repository permissionsは `Contents: write` にします。PATはツールrepoのActions secret `APP_HUB_DISPATCH_TOKEN` にだけ保存し、ログへ出力したり環境へ別経路で設定したりしません。次のようなWorkflowを追加します。

```yaml
name: Notify App Hub

on:
  push:
    branches: [main]

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch app-hub rebuild
        env:
          APP_HUB_DISPATCH_TOKEN: ${{ secrets.APP_HUB_DISPATCH_TOKEN }}
        run: |
          if [ -z "${APP_HUB_DISPATCH_TOKEN}" ]; then
            echo "APP_HUB_DISPATCH_TOKEN is not set"
            exit 1
          fi

          payload=$(printf '{"event_type":"tool_updated","client_payload":{"repo":"%s","sha":"%s"}}' "${GITHUB_REPOSITORY}" "${GITHUB_SHA}")

          curl --fail-with-body --silent --show-error -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${APP_HUB_DISPATCH_TOKEN}" \
            https://api.github.com/repos/big-mon/app-hub/dispatches \
            -d "${payload}"
```

app-hub側は `event_type: tool_updated` の通知だけでDeploy Workflowを起動します。

## Cloudflare Pagesの設定

Cloudflare Pagesでプロジェクトを作成し、GitHub ActionsのVariablesにプロジェクト名とアカウントIDを設定します。

Secrets:

- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` はDeploy actionの入力だけに渡し、hubやtoolのbuild環境変数には渡しません。

Variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `PROJECT_NAME`

## ツール側の注意

staticツールはサブパス配信のため、`/assets/...` のような絶対path参照を避け、相対pathを推奨します。nodeツールは必要に応じて `basePathEnv` を受け取り、Viteなどの `base` に反映してください。

## ライセンス

このリポジトリは [MIT License](LICENSE) です。


### 任意のAPI Worker

`tools.json` の `apiWorker` は配信ディレクトリ内の `.mjs` エントリです。default export の `fetch(request, env, ctx)` を `/<slug>/api` とその配下だけに接続し、その他は既存の静的配信・Markdown変換を維持します。登録コードは既存buildと同じ信頼境界です。`commit` に40桁SHAを指定すると、そのコミットを取得してビルドします。

rail-meetは既存の計算モジュールと生成JSONをWorkerへ同梱します。APIの仕様は `/rail-meet/developers`、OpenAPIは `/rail-meet/openapi.json`。IP別の制限は実行単位のベストエフォートで、全拠点共通の課金上限ではありません。API本番公開前に既存プランの使用枠・超過時挙動を確認し、必要なら別途承認を得てプラットフォーム側制限を設定してください。この変更では契約・bindings・セキュリティ設定を追加しません。

## Verified PR previews

Same-repository pull requests build the tracked manifest and deploy `dist` to an isolated `preview-pr-N` branch of the existing Cloudflare Pages project. The workflow reuses the production workflow's `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `PROJECT_NAME`; it does not add credentials or run for fork PRs. Build commands never receive Cloudflare credentials. No `pull_request_target` is used.

The preview is linked in one reusable PR comment only after its build identity, rail-meet HTML, network bytes, character asset, station API and recommendation API match the assembled output. A generic Cloudflare Git integration success check alone is not evidence of the correct content: an absent `/rail-meet/` asset can return the Hub's SPA fallback. `dist/preview-build.json` identifies the exact Hub head and checked-out rail-meet SHA. A stale run cannot replace the link after its PR head changes.

A rail-meet change still needs a matching app-hub manifest pin. The existing repository-scoped GitHub token cannot dispatch or write comments in the other repository; this workflow adds no cross-repository token or secret.

PRプレビューは、manifestの固定SHA付き `big-mon/rail-meet`（slug `rail-meet`、既存API Worker）専用です。削除・リネーム・参照先/API契約変更時は専用プレビューをスキップしてコメントに対象外と表示し、通常のビルド検証は継続します。checkout後、install/buildより先に前回のURLを検証待ち表示へ置換します。失敗・キャンセル時は古い検証済みURLを残しません。HTMLも組み立て済みファイルのSHA256と照合します。
