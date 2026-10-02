# Blave Agent

**量化工作台**

## 让你的 AI 学会做量化

免费开源，接上你的 Claude Code 或 Codex<br>
你讲想法，它写策略、跑回测、上线自动交易

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

> 本文译自英文版 README 的 commit [`1ac250b`](https://github.com/Blave-TW/blave-agent/blob/1ac250b/README.md)，只涵盖变动较少的段落；最新消息、交易场所与数据、云端主机、目录结构、贡献方式与维护者说明请看[英文版](README.md)。内容有出入时，以英文原文为准。

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/66c747e9-b068-4da9-a372-84d9afa7cb0d

[下载 macOS 版](https://github.com/Blave-TW/blave-agent/releases/latest) · [下载 Windows 版](https://download.blave.org/desktop/win/Blave-Setup.exe) · [快速开始（从源代码）](#quick-start) · [关电脑也照跑](https://blave.org/agent/cn)

觉得有用就点个 Star；想在新版发布时收到通知，请点 Watch › Releases。

## 跟别的交易 agent 不一样的地方

### 回测先查过拟合，手续费照实算

过拟合，指参数只是刚好贴合过去的数据。

- 每次 Type A 回测默认都会跑蒙特卡洛排列检验（MCPT，`lib/validation.py`），记下 p 值：把数据打乱之后，能不能做出一样好的成绩？
- 参数扫描（`lib/param_scan.py`）找的是「一整片都有效」的参数平台，不是最高的那一格。
- 滚动式样本外验证（walk-forward，`lib/walk_forward.py`）量样本外的表现。
- 手续费要符合真实市场。填 0 会被 `lib/quality_check.py` 标出来，并当成 bug 处理。
- 一个想法默认只回测一次。结果不好就照实回报，agent 不会偷偷调参数调到数字好看（见 [`AGENTS.md`](AGENTS.md) 的 *Iteration Brakes*）。

### 看得到实盘跑的是不是回测那份

回测会把策略定版。实盘跑的程序跟定版时不同，这支策略就会被标记——网页工作页显示「上线中 · 文件已改」，而不是干净的「上线中」。标记不会拦下运行。只适用有回测的策略类型（Type A 与 C），而且只限定过版的策略。

### 下单循环里没有 LLM

AI 负责研究与写程序。排程跑的是确定性的程序，`manager/reconciler.py` 把帐户对到目标部位。紧急停止开关（`state/HALT`）在下单函数库那一层拦掉新曝险，平仓与止损照常放行。

### 报告先看新闻再动笔

跟它要一份晨报、收盘报告、单一标的简报或研究报告，agent 会先上网读新闻——至少三个不同网站——才开始写。每张图都画自真实的数据序列，不是模型记忆里的数字。每份报告结尾有总结，加一条「什么会推翻这个结论」。爆仓地图把「已发生的强平」与「模型估计」画成两层，各自标明。

### 看得到它在读什么的浏览器

agent 上网查数据用的是 app 内置的浏览器：它正在读哪一页，就在你的画面上，不是藏在背景的进程。交易所帐户后台与内网地址一律拦下；这一轮没去过的网站、网址又带着长参数，会先停下来问你才开。

<a id="quick-start"></a>

## 快速开始（从源代码）

需要：

- macOS 13 以上。打包版是通用版：Apple Silicon 与 Intel 同一个安装文件。
- 或 Windows 10、11，x64（Electron 44 支持的版本；ARM 版尚未测试）。Windows 安装文件还没有代码签名，第一次安装时 Windows 会先弹出安全警告：点说明文字下方的链接，再点底部多出来的按钮。
- Node.js 22.12 以上与 npm（`shell/package.json` › `engines`）
- `PATH` 上有 `python3`。打包版自带 Python 3.12；从源代码跑时，venv 用的是你系统的 `python3`。
- 已安装并登录的 Claude Code 或 Codex，或一个 Blave 账号

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

第一次打开时，选 agent 用哪个 AI：

- **自己的 Claude Code 或 Codex。** 不需要 Blave 账号，Blave 不收 AI 费用。app 只负责启动 CLI，你的 Claude Code、Codex 登录凭证留在 CLI 自己手上。
- **Blave AI。** 登录 Blave 账号，按用量计费。

接着讲你的想法，例如：

- 「回测 BTCUSDT 4 小时线：20 期 SMA 上穿 60 期 SMA 做多，跌回下方就空手。手续费单边 0.05%。」
- 「用 BTC、ETH、SOL 做一个等权重的投资组合，每周再平衡，跑回测。」
- 「把这支策略的两个 SMA 长度扫一遍，告诉我参数平台在哪。」

动手写之前，agent 会先判断想法属于哪一型：

| 类型 | 是什么 | 回测 |
|---|---|---|
| A | 单一标的、固定周期；一个部位（多／空／空手） | 必做 |
| C | 投资组合：N 个标的加一组权重（总和不超过 1），定期再平衡 | 必做 |
| B | 其余全部：选股器、网格、套利、警示、一次性下单 | 不做 |

界面语言跟着系统语言（英文或繁体中文）。要强制指定：`BLAVE_LANG=zh npm start`。

## 最新消息

最新消息见英文版：[README.md › News](README.md#news)。

## 安全与边界

- **交易所密钥放在哪，看你用哪个表面。** 电脑版：写在你电脑上工作区的 `.env`（macOS 是 `~/Blave/workspace/.env`，Windows 是 `%USERPROFILE%\Blave\workspace\.env`）。云端主机：在你自己那台主机工作区的 `.env`。在网页绑定：由 Blave 加密保存。agent 读得到工作区的 `.env`，它的规则禁止打印密钥的值（`references/exchange-connect.md`）。密钥只给读取＋交易，不给提现。有提现权限的密钥在连接时会被拒绝（Binance、OKX、BingX、Bybit；电脑版、云端主机、网页绑定都一样）。Gate.io 查不到这个旗标，请自己确认。
- 投入金额与恢复交易由你自己做——电脑版在 app 的「自动下单」，云端主机在网页工作页。就算你开口要求，agent 也会拒绝代劳。它唯一可以随时自己做的，是触发紧急停止。
- 电脑版只有在 Blave 开着时才会下单；结束 app 再打开后，交易维持暂停，直到你点「启动下单」。
- agent 先验证再回报：改完文件会重读确认，下完单会向交易所查回结果才说「已下单」。每一次下单尝试都记在 `state/audit.jsonl`。
- 回测讲的是过去，不预测、也不保证未来绩效。MCPT 检查成绩在统计上显不显著，参数扫描检查是不是过拟合；两者都只能降低回测骗到你的概率，不能把它消掉。
- 这里没有任何内容是投资建议。交易可能亏损，包括亏光。

## 代码签名政策

Windows 版目前还没有代码签名：我们已向 [SignPath Foundation](https://signpath.org) 的开源项目计划申请，核准前 Windows 安装文件未经签名。核准后，Windows 版的代码签名由 [SignPath.io](https://signpath.io) 免费提供，证书属于 SignPath Foundation。每个版本都由本 repo 的公开 GitHub Actions workflow 从打了 tag 的 commit 构建，每次签名由 repo 拥有者核准。角色：作者与审查者＝有写入权限的维护者；核准者＝repo 拥有者。除[隐私权政策](https://blave.org/disclaimer/cn/privacy_policy)所述外，本程序不会把任何信息传给第三方。macOS 版以 Blave 自己的 Apple 身份签名与公证。

## 授权

**Apache-2.0**——见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。可以自由使用、修改、分发，含商业用途；含专利授权。「Blave」与 Blave 标志是商标：fork 请改名。

**你自己写的策略是你的。** `strategies/` 底下你（或 agent 替你）写出来的东西不属于本项目，授权不及于它。

付费的部分不在这个 repo 里：云端主机、市场数据与 Blave 的 LLM proxy 都是 blave.org 的服务。这份代码可以免费在你自己的电脑上跑，接你自己的 AI 订阅与你自己的数据源。

Claude Code 与 Codex 是各自所有者的产品；Blave Agent 与它们没有合作或背书关系。

---

## 给维护者与既有机器

维护者说明见英文版：[README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)。
