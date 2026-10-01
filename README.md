# 日々の記録

ブラウザーで日記を作成し、保存時にGoogleスプレッドシートへ同期するアプリです。日記は先にブラウザーへ保存され、通信できない場合は次回起動時または再接続時に同期を再試行します。

## スプレッドシートの準備

GASと紐づいたスプレッドシートに `diary` というシートを追加し、1行目に次の列名を入力してください。

`owner_id`、`date`、`title`、`content`、`mood`、`updated_at`

GASの保存APIは既存Webアプリdeploymentへ反映済みです。シートを追加すれば、アプリの保存操作から自動で同期されます。同期に失敗した場合はブラウザーに保留され、再接続時と30秒ごとに再試行されます。オフライン中や再試行待ちの状態は画面右上に表示されます。

## GASコードを変更した場合

```powershell
Push-Location gas
clasp push
clasp version "diary sync"
clasp deploy -i AKfycbyyjZigB9NvChT9dhJHPZ1xTsaqlR2QvKFYGqK1KASHZEIg85gTOGQ6pEWxUaK8uCL0
Pop-Location
```

ブラウザーごとに日記の保存領域を分けています。別の端末へ日記を読み込む機能はありません。GET URLの長さ制限により、非常に長い本文はシートへ同期できない場合があります。