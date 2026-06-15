# Dreamy MFA

Discord認証で保護された共有TOTP認証コード管理アプリです。Cloudflare Workers上で動作し、Cloudflare D1に保存したTOTPシードを使って、複数人で共有アカウントの二段階認証コードを確認できます。

## リポジトリの内容

- `worker/`  
  Cloudflare Workersのサーバー処理です。Discord OAuth、アクセス制御、D1からのデータ取得、TOTPシードの暗号化・復号を担当します。

- `index.html`, `app.js`, `styles.css`  
  ブラウザで動くフロントエンドです。認証コードの表示、コピー、QRコード読み取り、PWA、オフライン表示を担当します。

- `src/`  
  ブラウザ向けにバンドルする補助コードです。QRコード読み取りやAuthenticator関連のライブラリをまとめています。

- `scripts/`  
  Cloudflareへデプロイするために、必要な静的ファイルを`public/`へコピーする準備スクリプトです。

- `schema.d1.sql`  
  Cloudflare D1に作成するテーブル定義です。

- `manifest.webmanifest`, `sw.js`, `icons/`  
  PWA対応に必要なmanifest、Service Worker、アプリアイコンです。

- `wrangler.example.toml`  
  Cloudflare Workers用の設定テンプレートです。本番用の`wrangler.toml`は公開しない想定です。

## 使った技術

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Workers Static Assets
- Discord OAuth2
- Web Crypto API
- PWA / Service Worker
- Vanilla HTML / CSS / JavaScript
- esbuild
- authenticator
- jsQR

## アプリのフロー

1. ユーザーがページを開く

2. 未ログインの場合、Cloudflare WorkerがDiscordログイン画面へ誘導する

3. Discord OAuthでユーザー情報と参加サーバー情報を取得する

4. 許可されたDiscordサーバーに参加しているか確認する

5. 必要に応じて、許可ユーザーIDのリストでもアクセスを制限する

6. 認証に成功したら、署名付きCookieでセッションを保持する

7. フロントエンドが`/api/accounts`から登録済みアカウント情報を取得する

8. WorkerがD1から暗号化済みTOTPシードを読み出し、復号する

9. ブラウザ側でTOTPコードを30秒ごとに更新して表示する

10. サーバー時刻との差分を取得し、ブラウザ側の表示時刻とTOTP更新タイミングを補正する

11. オンライン時に取得したデータをブラウザに保存し、PWAではオフライン時も保存済みデータからTOTPコードを生成する

12. 管理者として許可されたDiscordユーザーだけが、QRコードやシード入力から新しい認証情報を追加・削除できる

## セキュリティ方針

- TOTPシードはD1に保存する前にAES-GCMで暗号化します。
- セッションは署名付きCookieで管理します。
- `.env`、`wrangler.toml`、`.wrangler/`、`public/`、`dist/`はGitHubに含めない運用です。
- オフライン利用のため、認証済みブラウザにはTOTPシードが保存されます。共有端末ではログアウトしてキャッシュを削除する想定です。
