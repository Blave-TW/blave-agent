# Blave Agent

## AI エージェントのためのクオンツ・ワークスペース

Claude Code や Codex で、戦略を書き、バックテストして自動売買まで動かす。無料・オープンソース。

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **日本語** | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

> この文書は英語版 README の commit [`c327a0d`](https://github.com/Blave-TW/blave-agent/blob/c327a0d/README.md) から翻訳したもので、変更の少ない節だけを訳しています。対応取引所とデータ、クラウドサーバー、ディレクトリ構成、コントリビュート方法、メンテナー向けの説明は[英語版](README.md)をご覧ください。内容に食い違いがある場合は、英語の原文が優先されます。

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[macOS 版をダウンロード](https://github.com/Blave-TW/blave-agent/releases/latest) · [Windows 版をダウンロード](https://download.blave.org/desktop/win/Blave-Setup.exe) · [クイックスタート（ソースから）](#quick-start) · [PC を閉じても動かす](https://blave.org/agent/ja)

役に立ったらリポジトリに Star を。新しいバージョンの通知を受け取るには Watch › Releases を選んでください。

## ほかのトレーディングエージェントとの違い

Claude Code や Codex でも売買ボットは書けます。難しいのは、それを実際に動かすことです。ターミナルでは、戦略の 1 つ 1 つがスクリプトのフォルダとチャットログになり、数個を超えると把握しきれなくなります。自分で自動売買を組むなら、スケジュール実行、取引所 API、ポジションの照合、再起動、キーの管理をすべて自分で扱うことになります。Blave Agent は、その欠けている部分です。

### 戦略はばらばらのスクリプトではなく、1 つのアプリに

![アプリ内の BTC ブレイクアウト戦略：バックテスト、取引履歴、パラメータ探索、アウトオブサンプル、コードのタブと、その横にエージェントの評価](docs/readme-backtest.png)

各戦略はサイドバーに並び、それぞれにバックテスト、取引履歴、パラメータ探索、アウトオブサンプル検証、コード、保存済みのバージョンが付いています。古いバージョンは一覧から復元でき、各戦略の取引金額は **Portfolio** ページ（ポートフォリオ）で設定します。

### 自動売買はもう組み込み済み

- **取引所を接続：** Binance、OKX、Bybit、BingX、Gate.io、または Windows では President Futures。キーはまず取引所側で確認され、出金できるキーは拒否されます（Gate.io はこの権限を返さないため、自分で確認してください）。
- **金額を設定して Start trading（取引を開始）を押す。** アプリが各戦略をスケジュールどおりに実行し、口座を目標ポジションに近づけます。すべての注文試行は記録されます（`state/audit.jsonl`）。
- メニューバーから **Pause trading (keep positions)**（取引を一時停止・ポジションは維持、Windows ではシステムトレイ）。アプリを終了して開き直した後は、Start trading をもう一度押すまで何も取引しません。
- **ペーパートレード**にはキーは不要です。

### 過剰最適化を確かめ、実際の手数料で計算するバックテスト

過剰最適化とは、パラメータがたまたま過去のデータに合っているだけの状態のことです。

- Type A のバックテストにはすべて **MCPT の p 値**（`lib/validation.py`）：データをシャッフルしても同じくらいの成績が出せたのではないか。
- **パラメータ探索**は、いちばん成績のよい 1 マスではなく平坦域を探します（`lib/param_scan.py`）。**walk-forward** でアウトオブサンプルの成績を測ります（`lib/walk_forward.py`）。
- **実際の手数料：** 手数料 0 には警告が出ます（`lib/quality_check.py`）。
- **1 つのアイデアに、バックテスト 1 回：** 悪い結果はそのまま報告し、こっそりパラメータを調整し直すことはしません（[`AGENTS.md`](AGENTS.md) の *Iteration Brakes*）。

### アイデアがない？ Web を探してきます

![内蔵ブラウザで十数のサイトを巡り、BTC と ETH の戦略アイデアを探すエージェント](docs/readme-browser.png)

**Search the Web for Ideas**（Web でアイデアを探す）を押すと、エージェントが十数のサイトを読み、バックテストできるアイデアを 3 つ持ち帰ります。それぞれにエントリーとエグジットのルールと出典 URL が付いています。1 つ選べば、エージェントがそれを実装してバックテストします。読むページはアプリ内蔵のブラウザで、あなたの画面に開きます。取引所のアカウントページとプライベートネットワークのアドレスはブロックされます。

<a id="quick-start"></a>

## クイックスタート（ソースから）

必要なもの：macOS 13 以降または Windows 10/11（x64）、Node.js 22.12 以降、`PATH` 上の Python 3、そして次のいずれか：サインイン済みの Claude Code または Codex、DeepSeek API キー、Blave アカウント。

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Windows では PowerShell で `npm.cmd install` と `npm.cmd start` を実行します。

初回起動時に、エージェントを動かす AI を選びます：

- **自分の Claude Code または Codex。** Blave アカウントは不要で、Blave は AI の料金を一切請求しません。
- **自分の DeepSeek キー。** 料金は DeepSeek から直接請求されます。キーはこのコンピューターのキーチェーンに残り、エージェントには渡りません。
- **Blave AI。** Blave アカウントでサインインします。従量課金です。

あとはアイデアを話すだけです：

- 「BTCUSDT の 4 時間足でバックテストして。20 期間 SMA が 60 期間 SMA を上抜けたらロング、下に戻ったらノーポジション。手数料は片道 0.05%。」
- 「その戦略の 2 つの SMA の長さを両方スキャンして、平坦域がどこにあるか見せて。」

エージェントはコードを書く前に、すべてのアイデアを 3 つのタイプのどれかに分類します：

| タイプ | 内容 | バックテスト |
|---|---|---|
| A | 固定の 1 銘柄・固定の時間足で、ポジションは 1 つ（ロング／ショート／ノーポジション） | 必須 |
| C | ポートフォリオ：N 銘柄と、合計が 1 以下のウェイトベクトル。スケジュールでリバランス | 必須 |
| B | それ以外すべて：スクリーナー、グリッド、アービトラージ、アラート、単発の執行 | なし |

<details>
<summary>プラットフォームについての補足</summary>

- パッケージ版の macOS アプリはユニバーサルビルドです（Apple Silicon と Intel）。Windows：Electron 44 が対応するバージョン。ARM は未テスト。Windows インストーラーにはまだコード署名がないため、初回インストール時に SmartScreen が警告します。「詳細情報」›「実行」を選んでください。
- Node.js のバージョン：`shell/package.json` › `engines`。パッケージ版は Python 3.12 を同梱しています。ソースから実行する場合は、システムの Python（`python3`、Windows では `python`）で venv を作成します。
- Codex は ChatGPT アプリに含まれています——Windows では Microsoft Store の「ChatGPT」（`winget install --id 9PLM9XGG6VKS -s msstore`）、Mac では ChatGPT.app。Windows では当面、npm の `@openai/codex` 0.161–0.162.1 は避けてください（サンドボックスが壊れています）。
- 自分の Claude Code または Codex を使う場合、アプリは CLI を起動するだけで、認証情報は CLI 側に残ります。DeepSeek キーは Windows では暗号化して保存され、エージェントのリクエストはアプリがローカルで中継します。
- PowerShell の実行ポリシーで `npm` スクリプトがブロックされても、`npm.cmd` なら動きます。
- インターフェースはシステムの言語に従います（英語または繁体字中国語）。上書きするには：`BLAVE_LANG=en npm start`（PowerShell：`$env:BLAVE_LANG="en"; npm.cmd start`）。

</details>

## 最新情報

各バージョンの変更点は [Releases](https://github.com/Blave-TW/blave-agent/releases) をご覧ください。

## 安全性と限界

- **キー：** 読み取りと取引の権限だけを付与してください。出金権限のあるキーは接続時に拒否されます（Binance、OKX、BingX、Bybit）。Gate.io はこの権限の情報を返さないため、ご自身で確認してください。キーの保存先は、あなたのコンピューター上のワークスペースの `.env`（`~/Blave/workspace/.env`、Windows では `%USERPROFILE%\Blave\workspace\.env`）か、あなた専用のクラウドサーバー、あるいは Web ページで連携した場合は Blave による暗号化保存です。エージェントはその `.env` を読めますが、ルールでキーの値を表示することは禁じられています（`references/exchange-connect.md`）。
- **投入金額の設定と取引の再開は、あなた自身が行います。** デスクトップアプリの **Auto trading** ページ（自動売買）、または Web のワークスペースで。頼まれても、エージェントは行いません。エージェントがいつでも自分の判断で行ってよいのは、キルスイッチを作動させることだけです。
- **デスクトップ版では、Blave が起動している間だけ注文が出ます。** 終了して開き直したあとは、**Start trading**（取引を開始）を押すまで取引は一時停止したままです。
- **確かめてから報告：** 注文は取引所に照会してから「発注した」と伝え、すべての試行は `state/audit.jsonl` に記録されます。
- バックテストが示すのは過去です。MCPT とパラメータ探索は、見ているものが運である可能性を下げますが、なくしはしません。ここにあるものはいずれも投資助言ではなく、取引では全額を失うこともあります。

## コード署名ポリシー

Windows 版にはまだコード署名がありません。[SignPath Foundation](https://signpath.org) のオープンソースプログラムに申請中で、承認されるまで Windows インストーラーは未署名です。承認後は、Windows のコード署名を [SignPath.io](https://signpath.io) が無償で提供し、証明書は SignPath Foundation が発行します。リリースは、このリポジトリの公開 GitHub Actions ワークフローがタグ付きのコミットからビルドし、署名リクエストはそのつどリポジトリのオーナーが承認します。役割：作成者とレビュアー——書き込み権限を持つメンテナー。承認者——リポジトリのオーナー。このプログラムは、[プライバシーポリシー](https://blave.org/disclaimer/ja/privacy_policy)に記載されている場合を除き、第三者に情報を一切提供しません。macOS 版は Blave 自身の Apple の署名 ID で署名・公証されています。

## ライセンス

**Apache-2.0**——[`LICENSE`](LICENSE) と [`NOTICE`](NOTICE) を参照してください。商用を含め、使用・改変・再配布ができ、特許の許諾も含まれます。「Blave」と Blave のロゴは商標です。フォークする場合は名前を変えてください。

**あなたが書いた戦略はあなたのものです。** `strategies/` 以下のものは本プロジェクトの一部ではなく、ライセンスも及びません。有料の部分——クラウドサーバー、マーケットデータ、Blave の LLM プロキシ——は blave.org のサービスで、このリポジトリにはありません。

Claude Code と Codex は、それぞれの所有者の製品です。Blave Agent はそれらと提携しておらず、推奨も受けていません。

---

## メンテナーと既存のマシン向け

メンテナー向けの説明は英語版をご覧ください：[README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
