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

2. Workerが署名付きCookieのセッションを確認する

3. 未ログインの場合はDiscordログイン画面へ誘導する

4. Discord OAuthでユーザー情報と参加サーバー情報を取得する

5. 指定されたDiscordサーバーに参加しているか確認する

6. `DISCORD_ALLOWED_USER_IDS` が設定されている場合、そのユーザーIDリストに含まれているか確認する

7. 認証に成功したら、署名付きCookieでセッションを保持する

8. ページ表示時、フロントエンドはまず`/api/me`を呼び出して現在のセッションを確認する

9. Workerは`/api/me`や各APIアクセスのたびに、現在のユーザーがallowlistに残っているか再確認する

10. allowlistから外されたユーザーがアクセスした場合、WorkerはセッションCookieを削除して401を返す

11. フロントエンドは401/403を受け取ると、ブラウザ内のオフライン用キャッシュを削除してログイン画面へ戻す

12. allowlist拒否やオンライン中の認証失敗では、PWAのオフラインモードへは切り替えない

13. 認証済みユーザーは`/api/accounts`から登録済みアカウント情報を取得する

14. WorkerはD1から暗号化済みTOTPシードを読み出し、AES-GCMで復号する

15. ブラウザ側でTOTPコードを30秒ごとに生成・更新して表示する

16. Workerから返されたサーバー時刻を使い、ブラウザ時刻との差分を補正してTOTP更新タイミングを合わせる

17. オンライン時に取得したアカウント情報とPWA用ファイルをブラウザに保存する

18. ブラウザが本当にオフラインの場合のみ、保存済みデータからPWAのオフラインモードを起動する

19. オフラインモードでは、保存済みTOTPシードからブラウザ内で認証コードを生成する

20. 管理者として許可されたDiscordユーザーだけが、QRコードやシード入力から新しい認証情報を追加・削除できる

## セキュリティ方針

- TOTPシードはD1に保存する前にAES-GCMで暗号化します。
- セッションは署名付きCookieで管理します。
- アクセス時にallowlistを再確認し、外されたユーザーは即ログアウトさせます。
- allowlist拒否時はPWAのオフラインキャッシュも削除します。
- `.env`、`wrangler.toml`、`.wrangler/`、`public/`、`dist/`はGitHubに含めない運用です。
- オフライン利用のため、認証済みブラウザにはTOTPシードが保存されます。共有端末ではログアウトしてキャッシュを削除する想定です。
