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

## ツール側の注意

### staticツール

サブパス配信のため、`/assets/...` のような絶対パス参照は避けてください。相対パスでの参照を推奨します。

### nodeツール

必要であれば `basePathEnv` を利用し、ツール側で `BASE_PATH` を受け取りビルド設定へ反映してください。

- 例: Vite の `base` を `process.env.BASE_PATH` から設定

## Cloudflare Pages の準備

1. Cloudflare Pages で新規プロジェクトを作成
2. プロジェクト名を `PROJECT_NAME` に設定（`.github/workflows/deploy.yml` の env）
3. カスタムドメイン設定は必要に応じて別途実施

## GitHub Secrets の設定

GitHubリポジトリの Secrets に以下を設定します。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## ローカルでの確認

```bash
node scripts/build-hub.mjs
ls dist
```

`dist/<slug>/index.html` などが生成されていればOKです。
