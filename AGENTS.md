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
- 日記の保存・削除は既存GASの `save_diary` / `delete_diary` modeで処理し、日付とブラウザーごとの owner_id をキーにする
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
- 辞書を増やすときは main.js の `emotionLexicon` / `sceneryColors` に追記する

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
