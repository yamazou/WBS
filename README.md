# WBS Viewer

WBS / MOM / Issue List / Overview をローカル環境で編集するアプリです。  
フロントは React + Vite、データ保存先はローカル SQLite (`.wbs-data/wbs.db`) です。

## 保存アーキテクチャ（現在）

- **ブラウザ内DBは使わない**
  - 以前の `sql.js` ブラウザDB保存を廃止
  - フロントは JSON スナップショットを送受信するのみ
- **ローカルDBへ直接保存**
  - `GET /__wbs_sqlite/snapshot`
  - `PUT /__wbs_sqlite/snapshot`
  - これらは Vite middleware (`vite.config.ts`) で処理
- **DB実体**
  - `.wbs-data/wbs.db`

## バックアップ運用

- バックアップ格納先: `.wbs-data/backups`
- 形式: `wbs-YYYYMMDD-HHMMSS-SSS.db`
- 保持: **10世代**
- 作成間隔: **最短30分**
- 復旧API: `POST /__wbs_sqlite/restore?date=...`

## 開発起動

```bash
npm install
npm run dev
```

## 復旧手順（推奨）

1. WBSタブを1つだけにする（他は閉じる）
2. `npm run dev` を再起動
3. ブラウザで `Ctrl+F5`（ハードリロード）
4. 画面の「復旧日付」から対象を選び「復旧」
5. 再読み込みして Project 一覧を確認

## 障害時チェック

確認ファイル: `.wbs-data/backup.log`

- `api.snapshot.get.fail`
  - 起動時スナップショット読込失敗
- `api.snapshot.put.blocked`
  - 空スナップショット上書き防止で拒否（409）
- `api.restore.ok`
  - 復旧成功
- `backup.create` / `backup.skip`
  - バックアップ作成・スキップ状況

## 補足

- 起動直後に異常が出る場合は、まず `npm run dev` 再起動 + `Ctrl+F5` を実施してください。
- バックアップDBが残っていれば、原則として復旧可能です。
