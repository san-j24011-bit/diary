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

## スプレッドシート
- GAS はスプレッドシートに紐づいていることを前提にする
- スプレッドシートの取得には下記を使う
const ss = SpreadsheetApp.getActiveSpreadsheet();
- シートの追加はユーザーが実施する
- シートの1行目はカラム名を入れる想定にする
- プログラム開発でシートの追加が必要になった時は、ユーザーにそのことを伝える
- シート作成用スクリプトは作らない
- ただしシート名が `yyyymm` などトランザクションで増える場合は、作成スクリプトがあってもよい

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
