<div align="center">

<img src="docs/icon.png" width="80" alt="">

# Blave Agent

**给 AI Agent 的量化工作台**<br>
用 Claude Code 或 Codex 写策略、跑回测、上线自动交易。免费开源。

<a href="https://github.com/Blave-TW/blave-agent/releases"><img src="https://img.shields.io/github/v/release/Blave-TW/blave-agent?filter=desktop-*&label=latest&color=555" alt="最新版本"></a>

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

<a href="https://download.blave.org/desktop/mac/Blave-universal.dmg"><img src="docs/readme-dl-mac.zh-CN.png" alt="下载 Mac 版" width="173"></a>&nbsp;&nbsp; <a href="https://download.blave.org/desktop/win/Blave-Setup.exe"><img src="docs/readme-dl-win.zh-CN.png" alt="下载 Windows 版" width="173"></a>

</div>

> 本文译自英文版 README 的 commit [`db5574d`](https://github.com/Blave-TW/blave-agent/blob/db5574d/README.md)。内容有出入时，以英文原文为准。

https://github.com/user-attachments/assets/66c747e9-b068-4da9-a372-84d9afa7cb0d

<p align="center"><a href="https://blave.org/docs/cn">文档</a></p>

## 你会得到

- **所有策略都在一个 app 里。** 每支都有回测、成交、参数扫描、版本。
- **回测会抓过拟合。** MCPT p 值、参数平台、样本外验证。
- **默认按真实手续费算。** 手续费填 0 会警告。
- **自动交易已经接好。** Binance、OKX、Bybit、BingX、Gate.io，以及台指期（Windows）。
- **模拟交易。** 不需要密钥。
- **上网帮你找点子。** 读几个网站，带回三个能回测的。
- **AI 自己选。** Claude Code、Codex、DeepSeek 密钥或 Blave AI。

![app 里的 BTC 突破策略](docs/readme-backtest.png)

<p align="center">⭐ 如果它帮你省下一个周末接 API，点个 Star。这能帮其他交易者找到它。</p>

<a id="quick-start"></a>

## 快速开始

1. 下载 [macOS](https://download.blave.org/desktop/mac/Blave-universal.dmg) 或 [Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) 版并打开。
2. 选 AI。
3. 说出你的点子：

> 回测 BTCUSDT 4 小时线：SMA 20 上穿 SMA 60 做多，下穿就平仓。单边手续费 0.05%。

<details><summary>平台说明</summary>

macOS 13 及以上（通用版）或 Windows 10/11 x64。Windows 安装包还没签名：选“更多信息 › 仍要运行”。

</details>

<details><summary>从源代码构建</summary>

需要 Node.js 22.12 以上，且 `PATH` 上有 Python 3。

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Windows 在 PowerShell 里改跑 `npm.cmd install` 与 `npm.cmd start`。

</details>

## 安全

- **只有你能配置资金与恢复交易。** agent 只能停。
- **每笔委托都跟交易所核对过**，记在 `state/audit.jsonl`。
- **回测只代表过去。** 交易可能亏光本金。

交易所与密钥：[文档](https://blave.org/docs/cn/exchange_api) · 数据来源：[加密](https://blave.org/docs/cn/data_crypto)、[台股](https://blave.org/docs/cn/data_twstock)

## 云端运行（付费）

关电脑策略也照跑，从网页或 Telegram 跟它对话。[方案](https://blave.org/agent/cn)

## 最新消息

每一版的内容：[Releases](https://github.com/Blave-TW/blave-agent/releases)。点 Watch › Releases 接收新版通知。

## 给开发者

<details><summary>目录结构、测试、贡献</summary>

先读 `AGENTS.md`，再读 `examples/README.md` 和 `references/lib.md`。`tests/` 一个契约一个文件。提 PR 前跑相关测试，并执行 `pre-commit install`。

</details>

## 授权

Apache-2.0。你写的策略归你。“Blave”是商标：fork 请改名。

Claude Code 与 Codex 是各自所有者的产品；Blave Agent 与它们没有合作或背书关系。

## 代码签名政策

Windows 版目前还没有代码签名：我们已向 [SignPath Foundation](https://signpath.org) 的开源项目计划申请，核准前 Windows 安装文件未经签名。核准后，Windows 版的代码签名由 [SignPath.io](https://signpath.io) 免费提供，证书属于 SignPath Foundation。每个版本都由本 repo 的公开 GitHub Actions workflow 从打了 tag 的 commit 构建，每次签名由 repo 拥有者核准。角色：作者与审查者＝有写入权限的维护者；核准者＝repo 拥有者。除[隐私权政策](https://blave.org/disclaimer/cn/privacy_policy)所述外，本程序不会把任何信息传给第三方。macOS 版以 Blave 自己的 Apple 身份签名与公证。

---

## 给维护者与既有机器

维护者说明见英文版：[README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)。
