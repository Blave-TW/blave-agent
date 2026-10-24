<div align="center">

<img src="docs/icon.png" width="80" alt="">

# Blave Agent

**AI エージェントのためのクオンツ・ワークスペース**<br>
Claude Code や Codex で、戦略を書き、バックテストして自動売買まで動かす。無料・オープンソース。

<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="ライセンス Apache-2.0"></a> <a href="https://github.com/Blave-TW/blave-agent/releases"><img src="https://img.shields.io/github/v/release/Blave-TW/blave-agent?filter=desktop-*&label=latest&color=f7931a" alt="最新リリース"></a> <img src="https://img.shields.io/badge/desktop-macOS%20%7C%20Windows-555" alt="macOS | Windows"> <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex-555" alt="Claude Code と Codex に対応">

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **日本語** | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

<a href="https://download.blave.org/desktop/mac/Blave-universal.dmg"><img src="docs/readme-dl-mac.ja.png" alt="Mac 版をダウンロード" width="250"></a>&nbsp;&nbsp; <a href="https://download.blave.org/desktop/win/Blave-Setup.exe"><img src="docs/readme-dl-win.ja.png" alt="Windows 版をダウンロード" width="250"></a>

</div>

> この文書は英語版 README の commit [`584f3c6`](https://github.com/Blave-TW/blave-agent/blob/584f3c6/README.md) から翻訳したものです。食い違いがある場合は英語の原文が優先されます。

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

<p align="center"><a href="#quick-start">クイックスタート</a> · <a href="https://blave.org/docs/ja">ドキュメント</a> · <a href="https://blave.org/agent/ja">PC を閉じても動かす</a></p>

## できること

- **すべての戦略を 1 つのアプリに。** 戦略ごとにバックテスト、取引履歴、パラメータ探索、保存済みバージョン。
- **過剰最適化を見抜くバックテスト。** MCPT の p 値、パラメータの平坦域、ウォークフォワード。
- **手数料は最初から実費。** 手数料 0 には警告が出ます。
- **自動売買はもう組み込み済み。** Binance、OKX、Bybit、BingX、Gate.io、Windows では台湾指数先物も。
- **ペーパートレード。** キーは不要です。
- **アイデアは Web から。** エージェントが十数サイトを読み、バックテストできる案を 3 つ持ち帰ります。
- **AI は自分で選べる。** Claude Code、Codex、DeepSeek キー、または Blave AI。

![アプリ内の BTC ブレイクアウト戦略](docs/readme-backtest.png)

<p align="center">⭐ API の配線に費やす週末が浮いたら、Star をお願いします。ほかのトレーダーが見つけやすくなります。</p>

<a id="quick-start"></a>

## クイックスタート

1. [macOS](https://download.blave.org/desktop/mac/Blave-universal.dmg) 版か [Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) 版をダウンロードして開きます。
2. AI を選びます：自分の Claude Code か Codex、DeepSeek キー、または Blave AI。
3. アイデアを話します：

> BTCUSDT の 4 時間足でバックテストして。SMA 20 が SMA 60 を上抜けたらロング、下に戻ったらノーポジション。手数料は片道 0.05%。

<details><summary>プラットフォームについて</summary>

macOS 13 以降（ユニバーサルビルド）または Windows 10/11 x64。Windows インストーラーはまだ署名されていません：「詳細情報 › 実行」を選んでください。

</details>

<details><summary>ソースからビルド</summary>

必要なもの：Node.js 22.12 以降、`PATH` 上の Python 3。

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Windows では PowerShell で `npm.cmd install` と `npm.cmd start` を実行します。

</details>

## 安全性

- **入金と取引の再開は、あなたにしかできません。** エージェントにできるのは停止だけです。
- **すべての注文は取引所に照会して確認され**、`state/audit.jsonl` に記録されます。
- **バックテストが示すのは過去です。** 取引では全額を失うこともあります。

取引所とキー：[ドキュメント](https://blave.org/docs/ja/exchange_api) · データソース：[暗号資産](https://blave.org/docs/ja/data_crypto)、[台湾株](https://blave.org/docs/ja/data_twstock)

## クラウドで動かす（有料）

PC を閉じても戦略は動き続け、Web や Telegram から話しかけられます。[プラン](https://blave.org/agent/ja)

## 最新情報

各バージョンの変更点：[Releases](https://github.com/Blave-TW/blave-agent/releases)。Watch › Releases で新しいバージョンの通知を受け取れます。

## 開発者向け

<details><summary>ディレクトリ構成、テスト、コントリビュート</summary>

まず `AGENTS.md`、次に `examples/README.md` と `references/lib.md` を読んでください。`tests/` は契約ごとに 1 ファイルです。PR の前に、変更に関わるテストを実行し、`pre-commit install` を実行してください。

</details>

## ライセンス

Apache-2.0。あなたが書いた戦略はあなたのものです。「Blave」は商標です。フォークする場合は名前を変えてください。

Claude Code と Codex は、それぞれの所有者の製品です。Blave Agent はそれらと提携しておらず、推奨も受けていません。

## コード署名ポリシー

Windows 版にはまだコード署名がありません。[SignPath Foundation](https://signpath.org) のオープンソースプログラムに申請中で、承認されるまで Windows インストーラーは未署名です。承認後は、Windows のコード署名を [SignPath.io](https://signpath.io) が無償で提供し、証明書は SignPath Foundation が発行します。リリースは、このリポジトリの公開 GitHub Actions ワークフローがタグ付きのコミットからビルドし、署名リクエストはそのつどリポジトリのオーナーが承認します。役割：作成者とレビュアー——書き込み権限を持つメンテナー。承認者——リポジトリのオーナー。このプログラムは、[プライバシーポリシー](https://blave.org/disclaimer/ja/privacy_policy)に記載されている場合を除き、第三者に情報を一切提供しません。macOS 版は Blave 自身の Apple の署名 ID で署名・公証されています。

---

## メンテナーと既存のマシン向け

メンテナー向けの説明は英語版をご覧ください：[README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
