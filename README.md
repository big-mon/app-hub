# app-hub

複数のミニツール（別々のGitHubリポジトリ）を1つのCloudflare Pagesプロジェクトに集約し、サブパスで配信するための公開用ハブリポジトリです。各ツールの実装や公開はこのリポジトリでは行わず、`tools.json` を追加するだけで `dist/<slug>/` に集約し、PagesへDirect Uploadします。

## 使い方

### 1) tools.json にツールを追加

`tools.json` に対象ツールを列挙します。

- `type=static`: `src` で指定したディレクトリを `dist/<slug>/` にコピーします
- `type=node`: `build` を実行し、`outDir` を `dist/<slug>/` にコピーします
- `basePathEnv` を指定すると、`/<slug>/` が環境変数としてビルド時に渡されます

例:

```json
[
  {
    "slug": "amazon-link-cleaner-cloudflare",
    "repo": "https://github.com/big-mon/amazon-link-cleaner-cloudflare",
    "type": "static",
    "src": "./public"
  },
  {
    "slug": "sample-node-tool",
    "repo": "https://github.com/<owner>/tool-bbb",
    "type": "node",
    "build": "npm ci && npm run build",
    "outDir": "dist",
    "basePathEnv": "BASE_PATH"
  }
]
```

### 2) GitHub Actions でデプロイ

`main` への push または手動実行で以下が行われます。

1. 各ツールrepoを `git clone --depth 1` で取得
2. 成果物を `dist/<slug>/` に集約
3. `wrangler pages deploy dist` でDirect Upload

### 3) ツール更新時の自動再ビルド

各ツールリポジトリの更新をトリガーに、app-hub を再ビルドする場合は
ツール側に `repository_dispatch` を送るWorkflowを追加します。

1. app-hub へ送信できるPATを用意し、ツールrepoの Secrets に `APP_HUB_DISPATCH_TOKEN` を設定
2. ツールrepoに以下のWorkflowを追加

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

          curl -sS -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${APP_HUB_DISPATCH_TOKEN}" \
            https://api.github.com/repos/<owner>/app-hub/dispatches \
            -d "${payload}"
```

## ツール側の注意

### staticツール

サブパス配信のため、`/assets/...` のような絶対パス参照は避けてください。相対パスでの参照を推奨します。

### nodeツール

必要であれば `basePathEnv` を利用し、ツール側で `BASE_PATH` を受け取りビルド設定へ反映してください。

- 例: Vite の `base` を `process.env.BASE_PATH` から設定

## Cloudflare Pages の準備

1. Cloudflare Pages で新規プロジェクトを作成
2. プロジェクト名を GitHub Variables の `PROJECT_NAME` に設定（Settings → Secrets and variables → Actions → Variables）
3. カスタムドメイン設定は必要に応じて別途実施

## GitHub Secrets の設定

GitHubリポジトリの Secrets に以下を設定します。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

GitHubリポジトリの Variables に以下を設定します。

- `PROJECT_NAME`

## ローカルでの確認

```bash
node scripts/build-hub.mjs
ls dist
```

`dist/<slug>/index.html` などが生成されていればOKです。
