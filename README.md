# Eagle CT Tagger

`Eagle CT Tagger` は、`camie-tagger` を使って Eagle 上の二次元イラストに自動でタグを付与する Eagle 向けプラグインです。

推論結果のタグはすべて `CT/` プレフィックス付きで追加され、`Camie Tagger` というタググループにまとめられます。

## 主な機能

- Eagle で選択中の画像をまとめて解析
- `camie-tagger` の推論結果を Eagle のタグとして付与
- タグ名の衝突回避のため、すべてのタグに `CT/` を付与
- `Camie Tagger` タググループを自動作成し、生成タグをまとめて管理
- 付与するカテゴリを選択可能
  - `general`
  - `character`
  - `copyright`
  - `artist`
  - `meta`
- 画像ファイルが見つからない場合は、そのアイテムだけをスキップして継続

## 動作要件

- Windows 版 Eagle
- `camie-tagger` のリポジトリ一式
- `camie-tagger` 側で仮想環境作成済みであること
- `venv/Scripts/python.exe` から推論を実行できること

本プラグインは、ユーザーが指定した `camie-tagger` リポジトリ内の以下のファイルを利用します。

- `venv/Scripts/python.exe`
- `camie-tagger-v2.onnx`
- `camie-tagger-v2-metadata.json`

## ディレクトリ構成

```text
eagle-ct_tagger/
├─ manifest.json
├─ index.html
├─ styles.css
├─ logo.png
├─ src/
│  ├─ plugin.js
│  ├─ tagger.js
│  └─ infer.py
├─ eagle-plugin-docs/
└─ SPEC.md
```

## インストール方法

1. このリポジトリを任意の場所に配置します。
2. Eagle を開きます。
3. `プラグイン` から開発者向けメニューを使い、このフォルダをプラグインとして読み込みます。
4. プラグイン一覧から `Eagle CT Tagger` を起動します。

## 使い方

1. Eagle 上でタグ付けしたい画像を選択します。
2. プラグインを開きます。
3. `camie-tagger リポジトリパス` を指定します。
4. 必要に応じて以下を調整します。
   - 閾値
   - カテゴリごとの最大タグ数
   - 付与するタグカテゴリ
5. `設定を保存` を押します。
6. `選択中アイテムを解析` を押します。

## 設定項目

### camie-tagger リポジトリパス

`camie-tagger` を配置したフォルダです。プラグインはここから Python 実行ファイル、モデル、メタデータを参照します。

### 閾値

推論結果をタグとして採用するしきい値です。小さいほど多くのタグが付きやすくなります。

### カテゴリごとの最大タグ数

各カテゴリごとに採用する最大タグ数です。

### 付与するタグカテゴリ

推論結果のうち、実際に Eagle に付与するカテゴリを選択します。少なくとも 1 つは選択する必要があります。

## タグ付与の仕様

- 追加されるタグ名は `CT/<tag>` 形式です
- 既存タグは削除せず、重複を避けて追加します
- 生成タグは `Camie Tagger` グループへ登録されます
- 該当グループが存在しない場合は自動で新規作成します

## 対応画像形式

現状、次の拡張子を対象にしています。

- `jpg`
- `jpeg`
- `png`
- `webp`
- `bmp`
- `gif`
- `avif`
- `tif`
- `tiff`

選択中アイテムのうち、これらに該当しないものは処理対象外です。

## エラーと挙動

### 画像が見つからない場合

`画像が見つかりません` エラーが返ったアイテムはスキップし、残りのアイテムの処理を継続します。

### タググループの追加に失敗した場合

`addTags()` が使えない、または失敗する環境では `save()` ベースの更新にフォールバックします。

### Eagle API の互換性

Eagle のビルド差異を考慮して、`countSelected()` が使えない環境では `getSelected()` にフォールバックしています。

## 開発メモ

- UI エントリポイントは [index.html](./index.html)
- プラグイン本体は [src/plugin.js](./src/plugin.js)
- Python ブリッジは [src/tagger.js](./src/tagger.js)
- 推論プロセスは [src/infer.py](./src/infer.py)
- 仕様書は [SPEC.md](./SPEC.md)

## ライセンス

必要であれば、別途ライセンスファイルを追加してください。
