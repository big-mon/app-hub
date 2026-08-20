# app-hub

複数のミニツール（別々のGitHubリポジトリ）を1つのCloudflare Pagesプロジェクトに集約し、サブパスで配信する公開用ハブです。各ツールの実装や公開はこのリポジトリでは行わず、`tools.json` の定義から `dist/<slug>/` を作成します。

## ローカル開発

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

まとめて実行する場合は `pnpm check` を使います。ビルドは各ツールをcloneしてビルドし、`dist/index.html` と `dist/<slug>/` を作成します。`dist` と `_tmp` は生成物のためGit管理しません。

## tools.json にツールを追加

`tools.json` に対象ツールを列挙します。

- `type=static`: `src`（省略時はリポジトリroot）を `dist/<slug>/` にコピーします
- `type=node`: `build` を実行し、`outDir` を `dist/<slug>/` にコピーします
- `basePathEnv` を指定すると、ビルド時に `/<slug>/` を環境変数へ渡します
- `src` と `outDir` はclone rootの外へ出ない相対pathにします
- 公開する `src`/`outDir` の配下はシンボリックリンクを拒否し、`.git` のディレクトリ/エントリは除外します（`src: "."` も利用できます）
- manifestに登録したnodeリポジトリと依存関係・install/buildスクリプトは、登録時に信頼するコードです。`build` は追跡対象manifestのshell契約として実行します。

nodeツールの例:

```json
{
  "slug": "image-compressor-web",
  "title": "ローカルで画像をトリミング・圧縮",
  "repo": "https://github.com/big-mon/image-compressor-web",
  "type": "node",
  "build": "pnpm install --frozen-lockfile && pnpm run build",
  "outDir": "dist",
  "basePathEnv": "BASE_PATH"
}
```

## GitHub Actions

CIは `pull_request` と `main` への `push` で起動し、依存関係をfrozen installしてtestとbuildだけを実行します。CIではCloudflareのSecretsを使わず、デプロイもしません。

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
