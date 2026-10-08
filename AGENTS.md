## エージェント
日本語で絵文字を使って返答する
ユーザーからデザインの指定が無ければ、モダンなライトデザインをデフォルトにする
AGENTS.mdの内容はプロダクトの要件に変更がある度に適宜修正する

# GAS + Web 実装仕様

## 前提
- ローカルサーバーは `npx serve public -p 3000` で起動する
- Docker は使わない
- コマンドはエンジニアが実行する（VSCode では「Ctrl + @」でターミナルが開く）

## ディレクトリ構成
public/
  index.html
  style.css
  main.js
gas/
  code.js

## public ディレクトリ
- フロントエンドのコードを配置する
- サーバーでは `public` 配下をルートとして扱う

## gas ディレクトリ
- Google Apps Script のコードを配置する
- 初回のサーバーへの反映作業はユーザー実施を前提にする（デプロイ→ウェブアプリ→権限をプロダクトに合うように選択→デプロイ）

## GASの普遍的なルール
- プロジェクト直下に `gas` ディレクトリがなければ作成する
- GAS の作業は必ず `gas` ディレクトリの中で行う
- このブラウザ版のエディタ画面URLを基にして、まずは `clasp clone` してから開発を進める
  - https://script.google.com/u/0/home/projects/1bc0Bu-gR1nwxMhB_7kgRbvyID2jmebD3abcBgE6Kj6Serg_J5J2jj35J/edit
- フロントエンドにハードコードする GAS のエンドポイントはこちら
  - https://script.google.com/macros/s/AKfycbyyjZigB9NvChT9dhJHPZ1xTsaqlR2QvKFYGqK1KASHZEIg85gTOGQ6pEWxUaK8uCL0/exec
- GAS は JavaScript から GET しか受信できないため、通信は GET を使い、`mode` パラメータで処理を切り替える
- 例: `?mode=list_view` / `?mode=edit_item`

## スプレッドシート
- GAS はスプレッドシートに紐づいていることを前提にする
- スプレッドシートの取得には下記を使う
const ss = SpreadsheetApp.getActiveSpreadsheet();
- シートの追加はユーザーが実施する
- シートの1行目はカラム名を入れる想定にする
- プログラム開発でシートの追加が必要になった時は、ユーザーにそのことを伝える
- シート作成用スクリプトは作らない
- ただしシート名が `yyyymm` などトランザクションで増える場合は、作成スクリプトがあってもよい

## 日記アプリのスプレッドシート
- スプレッドシート名: `日記アプリ`
  - https://docs.google.com/spreadsheets/d/1trNPP8MFtzEeoSNqt1HREJQfWTd6ASVOvhjp_pj17qY/edit
- GASはこのスプレッドシートのコンテナバインドスクリプトである前提（`getActiveSpreadsheet()` を使う）
- `diary` シートはユーザーが作成し、1行目に `owner_id`, `date`, `title`, `content`, `mood`, `updated_at` を設定する
- 日記の保存・削除はGASの `save_diary` / `delete_diary` modeで処理し、日付と認証済みユーザーのidをowner_idのキーにする。owner_idはサーバーでセッションから決定する。
- フロントエンドはローカル保存後にGASへ同期し、通信失敗時は再試行キューに残す
- 日記データはGETのBase64URL payloadで送る。長文によりURLが6000文字を超える場合は同期しない（キューから外し、ローカル保存のみとする）
- 再試行は「起動時」「オンライン復帰時」「30秒ごと」に行い、オフライン・再試行待ちの状態を画面に表示する
- GASは `date` を文字列として書き込み（日付型への自動変換を防ぐ）、先頭が `= + - @` タブ・改行の値は `'` を付けて数式化を防ぐ

## ことばから雰囲気を描く機能（無料）
- 有料APIは使わない。日記のタイトル・本文・気分から、ブラウザー内の辞書で雰囲気を解析する（通信なし・オフラインでも動く）
- 感情の辞書（5種類）で模様 `soft` / `wave` / `burst` / `rain` / `calm` と基本の色を決め、情景の言葉（桜・海・夕焼けなど）の色をパレットに混ぜる
- 生成する値は `palette`（#RRGGBB を最大4色）、`keywords`（3語）、`phrase`（一言）、`pattern`、`intensity`（low / medium / high）
- 入力中に400msの間隔で描き直し、保存時に日記の `atmosphere` として保存する
- 画像はフロントで SVG の抽象アートとして描く（日付＋一言をシードにして同じ日記は同じ絵になる）
- `diary` シートに任意の `atmosphere` 列があれば JSON で同期する。GAS 側でも値を検証する（色は #RRGGBB のみ）
- タイトル・本文のポジティブ表現（burst・soft辞書の合計）とネガティブ表現（rain辞書）の出現数を比較し、多い側のカードを表示する。同数（0件同士を含む）はcalm・一言「平凡な日」と穏やかな配色にする。気分選択は件数に加えない。重なる辞書語は長い表現を優先して1件と数え、別の箇所の繰り返しはそれぞれ数える。ネガティブ優勢時は青灰色と「心に雨が降る日」を表示する。入力400ms後・保存時・日記を開く時に再判定する。
- ポジティブ表現は `burst`（喜び・達成感・期待・自信）と `soft`（安心・感謝・ぬくもり・人とのつながり）に漢字／かな／口語を登録する。両辞書の合計を比較に使い、同じ箇所の語幹・長い表現は重複カウントしない。
- 辞書を増やすときは main.js の `emotionLexicon` / `sceneryColors` に追記する
- ネガティブな表現は `emotionLexicon` の `rain` 辞書で、悲しみ・疲労・不安・怒り・自己否定などの漢字／かな／口語を検知する。活用形は共通の語幹を使い、同じ表現の重複登録を避ける。辞書による部分一致であり、否定や文脈の完全な判定は行わない。

## フロントエンドの fetch 通信
- 通信先は GAS にする
- GAS の制約としてフロントエンドから POST 受信ができない点を考慮する
- 本来 POST である通信も GET で送る
- 本来 body に入れる内容も GET パラメーターに付与する
- GAS 側では `doGet` で受信し、`mode` パラメーターで処理を分岐する
- 例: `?mode=list_view` / `?mode=edit_item`

## ユーザーから GAS + 静的フロントでは実装が難しい要求を受けた場合
- 制約を短く説明する
- 代替案を提示する

### 例1: ゲーム
- リアルタイム通信や WebSocket が必要なゲームは難しい
- ゲーム本体はフロントで実行する
- 結果だけ GAS に保存する
- 開始時の初期条件だけ GAS から取得する

### 例2: 画像アップロード
- フロントエンドで画像をリサイズする
- リサイズ上限は 200x200 にする
- 200x200 が上限であることをユーザーに伝える
- ユーザーが了承した場合のみ実装する
- GET パラメーターが長くなりすぎないようにする
- Base64 で送信する



## 既存Google Apps Scriptを clasp で管理する手順

### 前提
- 既に Google Apps Script プロジェクトが存在している
- 一度はブラウザ画面から Webアプリ等として deploy 済み
- Node.js インストール済み

まだデプロイされていない場合は、ユーザーにこのコードでデプロイするように下記のコードを提示する。
const getA1 = (e) => {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const value = sheet.getRange('AI1').getValue();
  return value;
}


const doGet = (e) => {

  let response;

  // e の中の mode で実行する関数を切り替える
  // e を投げてその後の処理は関数に任せる
  // 現時点では参照しない

  response = getA1(e);

  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  output.setContent(JSON.stringify({ response }));
  return output;
};



### clasp インストール

PowerShell
npm install -g @google/clasp



### Googleログイン

cd gas
clasp login
cd ..

ブラウザが開くので許可する



### 既存GASを clone

Apps Script 編集画面URLから script ID を確認する

例

https://script.google.com/home/projects/AAAAAAAAAAAAAAAAAAA/edit

この場合の script ID

AAAAAAAAAAAAAAAAAAA

以下コマンドの script ID を適宜書き換える

cd gas
clasp clone AAAAAAAAAAAAAAAAAAA
cd ..

実行すると以下が作成される

- .clasp.json
- appsscript.json
- gsファイル



### deploy ID 確認

cd gas
clasp deployments
cd ..

表示例

- deploymentId: AKfycbxxxxxxxxxxxxxxxxxxxx

表示された deploymentId を控える

以後の deploy コマンド内の deployment ID は適宜書き換える



### コード修正

gas フォルダ内を編集する



### GASへ反映

cd gas
clasp push
cd ..

ローカルコードが GAS にアップロードされる

注意：

まだ本番 deploy は更新されていない



### version 作成

cd gas
clasp version "2026-05-11 update"
cd ..

version のスナップショットを作成する



### 本番 deploy 更新

deployment ID を適宜書き換える

cd gas
clasp deploy -i AKfycbxxxxxxxxxxxxxxxxxxxx
cd ..

既存 deploy に対して最新版 version を反映する



### 普段の更新手順

cd gas
clasp push
cd ..
cd gas
clasp version "2026-05-11 update"
cd ..
cd gas
clasp deploy -i AKfycbxxxxxxxxxxxxxxxxxxxx
cd ..



### 補足

script ID
→ GASプロジェクト本体ID

deployment ID
→ Webアプリ公開用ID

別物



### deploy ID を忘れた場合

cd gas
clasp deployments
cd ..

で再確認可能



### 初回 deploy が存在しない場合

cd gas
clasp deploy
cd ..

を実行すると新しい deployment ID が発行される



## ⚠ 文字コード設定（PowerShell 環境）
**必須:** ファイル読み書きは UTF-8 を明示的に指定する。

## ネガティブカードの名言
- ネガティブ優勢でrainカードが出る場合のみ、原典確認済みの偉人の名言・著者・出典リンクを表示する。日本語はアプリ訳と明示する。
- 名言はmain.jsのencouragementQuotesに保持し、日付で選ぶ。同じ日付は同じ名言、翌日は次の名言を表示する。オフラインでも本文と著者を表示できる。ポジティブ・同数・空欄では非表示にする。

## ユーザー名ログイン
- ユーザー名・パスワードの認証を必須にし、日記の保存・取得・削除にGASでセッションを検証する。
- usersはid, username, password_hash, salt, iterations, name、sessionsはuser_id, token_hash, expired_atを1行目に設定し、ユーザーが作成する。
- PBKDF2-SHA256（210000回）と一度限りのHMACチャレンジを使う。平文パスワードは送らず、セッションは24時間。5回失敗で約15分停止する。
- public/auth.jsがログイン状態、main.jsがアカウント別ローカル保存・取得・同期を管理する。ログイン画面の新規登録からユーザー名・表示名（任意）・パスワード・確認入力で登録でき、完了後に自動ログインする。管理者向けgas/create-user.cjsも利用できる。
- 旧ブラウザー単位の日記は削除せず残し、自動でアカウントに引き継がない。ログイン後の取り込みボタンと確認で、日付の重複を避けてアカウントに引き継げる。詳しい設定手順はgas/LOGIN_SETUP.md。

- 新規登録はregister_challenge/register_userをGETで扱う。2分有効・一度限りの登録キーで認証用ハッシュをマスクし、平文パスワードや認証用ハッシュをURLに載せない。登録時はロック内でユーザー名重複を再確認する。フォームのパスワードは5〜128文字。users/sessionsのシートは引き続きユーザーが用意する。

## 新規登録者の一覧
- 新規登録者はusersシートに1人1行で追加し、id・username・nameで一覧確認する。任意のcreated_at列がある場合は登録日時も記録する。既存行の登録日時は推測して埋めない。
- usersには認証用のpassword_hash・saltが含まれるため、一般公開やアプリへの一覧配信は行わない。シートの作成・created_at列の追加はユーザーが行う。

- ユーザー名は文字種・3文字以上・40文字以下の制限を設けず、日本語・絵文字・記号・内部の空白を許可する。空欄・重複は不可、前後の空白を除去し英字の大文字小文字は区別しない。数値への変換や数式化を避けるためusersに文字列として書き込む。認証試行のキャッシュキーには名前のSHA256を使う。

## スマートフォンUI
- 760px以下では入力欄の文字は16px以上、主要操作は44px以上のタップ領域にする。日記一覧だけを横スクロールにし、画面全体は横にはみ出させない。
- 気分の5択は等幅で配置し、保存ボタンは幅いっぱいに表示する。同期状態は折り返し、スマホではキーボードショートカットを非表示にする。
- viewport-fit=coverとsafe-area-inset-bottomを使い、下端のホームインジケーターとトーストの重なりを避ける。

## 公開時のブラウザーキャッシュ
- index.htmlのCSS・JSの参照URLに、各ファイルのSHA256先頭12文字をvパラメーターとして付ける。CSS・JSの内容変更時は参照ハッシュも更新し、旧CSSによるログイン画面の崩れやhidden属性の無効化を防ぐ。

## 新しい日記ボタン
- ＋ボタンは今日の既存記録を開き直すのではなく、タイトル・本文・気分・雰囲気を空にした新規下書きを表示し、タイトルへフォーカスする。未保存の文章があれば破棄前に確認する。
- 保存は従来どおり1ユーザー・1日1件。同じ日付に既存の日記がある新規下書きは保存前に上書きを確認し、キャンセル時は既存データを残す。別の日の日記は日付欄から選べる。
