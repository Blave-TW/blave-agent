# Blave Agent

## Espaço de trabalho quant para agentes de IA

Crie, faça backtest e opere estratégias ao vivo com Claude Code ou Codex. Grátis e de código aberto.

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | **Português** | [Tiếng Việt](README.vi.md)

> Esta tradução foi feita a partir do README em inglês no commit [`c327a0d`](https://github.com/Blave-TW/blave-agent/blob/c327a0d/README.md) e cobre só as seções que mudam pouco. Exchanges e dados, nuvem, estrutura do repositório, como contribuir e as notas para mantenedores estão na [versão em inglês](README.md). Se algo divergir, vale o original em inglês.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Baixar para macOS](https://github.com/Blave-TW/blave-agent/releases/latest) · [Baixar para Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) · [Início rápido (a partir do código-fonte)](#quick-start) · [Continue rodando com o PC desligado](https://blave.org/agent/pt)

Se for útil, dê uma estrela ao repositório, e ative Watch › Releases para saber de cada versão nova.

## O que o torna diferente

Claude Code ou Codex conseguem escrever um bot de trading. Colocá-lo para rodar de verdade é a parte difícil. No terminal, cada estratégia é uma pasta de scripts e um histórico de chat, e passando de algumas fica difícil acompanhar todas. Montar o seu próprio trading automático significa cuidar você mesmo de agendamento, APIs das exchanges, reconciliação de posições, reinícios e chaves. O Blave Agent é essa parte que falta.

### Suas estratégias em um só app, não em scripts espalhados

![Uma estratégia de rompimento de BTC no app: abas de backtest, operações, varredura de parâmetros, fora da amostra e código, com o veredito do agente ao lado](docs/readme-backtest.png)

Cada estratégia fica na barra lateral com seu backtest, operações, varredura de parâmetros, teste fora da amostra, código e versões salvas. Restaure uma versão antiga pela lista e defina quanto cada estratégia opera na página **Portfolio** (Portfólio).

### Trading automático já configurado

- **Conecte uma exchange:** Binance, OKX, Bybit, BingX, Gate.io ou President Futures no Windows. A chave é verificada primeiro com a exchange, e uma chave que pode fazer saques é recusada (a Gate.io não informa essa permissão, então confira você mesmo).
- **Defina um valor e clique em Start trading** (Iniciar trading). O app roda cada estratégia no horário e leva a conta em direção às posições-alvo. Cada tentativa de ordem fica registrada (`state/audit.jsonl`).
- **Pause trading (keep positions)** (Pausar trading, manter posições) na barra de menus (bandeja do sistema no Windows). Depois de fechar e reabrir o app, nada é operado até você clicar em **Start trading** de novo.
- **Paper trading** não precisa de chaves.

### Backtests que verificam overfitting e usam taxas reais

Overfitting: parâmetros que só por acaso se encaixam nos dados passados.

- **Valor p do MCPT** em todo backtest de Tipo A (`lib/validation.py`): dados embaralhados poderiam ter se saído tão bem?
- **Varredura de parâmetros** em busca de um platô, não da melhor célula isolada (`lib/param_scan.py`); **walk-forward** para resultados fora da amostra (`lib/walk_forward.py`).
- **Taxas reais:** uma taxa 0 gera um aviso (`lib/quality_check.py`).
- **Uma ideia, um backtest:** um resultado ruim é relatado como está, sem reajuste silencioso (*Iteration Brakes* em [`AGENTS.md`](AGENTS.md)).

### Sem ideias? Ele pesquisa na web por você

![O agente pesquisando uma dúzia de sites atrás de ideias de estratégia para BTC e ETH no navegador integrado](docs/readme-browser.png)

Clique em **Search the Web for Ideas** (Pesquisar ideias na web) e o agente lê uma dúzia de sites e traz três ideias que dá para testar em backtest, cada uma com regras de entrada e saída e a URL da fonte. Escolha uma e ele a monta e faz o backtest. As páginas que ele lê abrem no navegador integrado do app, na sua tela; páginas de conta das exchanges e endereços de redes privadas são bloqueados.

<a id="quick-start"></a>

## Início rápido (a partir do código-fonte)

Você precisa de macOS 13+ ou Windows 10/11 (x64), Node.js 22.12+, Python 3 no seu `PATH` e uma destas opções: Claude Code ou Codex com login feito, uma chave de API da DeepSeek ou uma conta Blave.

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

No Windows, rode `npm.cmd install` e `npm.cmd start` no PowerShell.

Na primeira abertura, você escolhe o que move o agente:

- **Seu próprio Claude Code ou Codex.** Não precisa de conta Blave; a Blave não cobra nada pela IA.
- **Sua própria chave da DeepSeek.** A DeepSeek cobra você diretamente. A chave fica no chaveiro deste computador e nunca chega ao agente.
- **Blave AI.** Entre com uma conta Blave; cobrada por uso.

Depois, descreva uma ideia:

- "Faça o backtest de BTCUSDT no gráfico de 4h: comprado quando a SMA de 20 períodos cruzar acima da SMA de 60, fora do mercado quando cruzar de volta para baixo. Use uma taxa de 0.05% por lado."
- "Varra os dois comprimentos de SMA dessa estratégia e me mostre onde está o platô."

Antes de escrever código, o agente classifica cada ideia em um de três tipos:

| Tipo | O que é | Backtest |
|---|---|---|
| A | Um símbolo fixo em um intervalo fixo; uma posição (comprado / vendido / fora) | Obrigatório |
| C | Um portfólio: N símbolos e um vetor de pesos que soma no máximo 1, rebalanceado conforme um calendário | Obrigatório |
| B | Todo o resto: screeners, grids, arbitragem, alertas, execução pontual | Nenhum |

<details>
<summary>Notas por plataforma</summary>

- O app empacotado para macOS é um build universal (Apple Silicon e Intel). Windows: as versões que o Electron 44 suporta; ARM não testado. O instalador do Windows ainda não tem assinatura de código, então o SmartScreen avisa na primeira instalação: escolha More info › Run anyway (Mais informações › Executar assim mesmo).
- Versão do Node.js: `shell/package.json` › `engines`. O app empacotado traz o próprio Python 3.12; rodando a partir do código-fonte, o Python do seu sistema (`python3`, ou `python` no Windows) é usado para criar o venv.
- O Codex vem dentro do app do ChatGPT — “ChatGPT” da Microsoft Store no Windows (`winget install --id 9PLM9XGG6VKS -s msstore`), ChatGPT.app no Mac. No Windows, evite por enquanto os builds 0.161–0.162.1 do `@openai/codex` via npm (o sandbox deles está quebrado).
- Com seu próprio Claude Code ou Codex, o app só inicia o CLI; suas credenciais ficam com ele. Uma chave da DeepSeek é guardada criptografada no Windows, e o app repassa as requisições do agente localmente.
- `npm.cmd` funciona mesmo quando a política de execução do PowerShell bloqueia o script `npm`.
- A interface segue o idioma do sistema (inglês ou chinês tradicional). Para forçar: `BLAVE_LANG=en npm start` (PowerShell: `$env:BLAVE_LANG="en"; npm.cmd start`).

</details>

## Novidades

As mudanças de cada versão estão em [Releases](https://github.com/Blave-TW/blave-agent/releases).

## Segurança e limites

- **Chaves:** conceda apenas permissões de leitura e trading. Uma chave com permissão de saque é recusada na conexão (Binance, OKX, BingX, Bybit); a Gate.io não informa essa permissão, então confira você mesmo. As chaves ficam no `.env` do espaço de trabalho no seu computador (`~/Blave/workspace/.env`, `%USERPROFILE%\Blave\workspace\.env` no Windows) ou no seu próprio servidor na nuvem, ou criptografadas pela Blave quando vinculadas pela página web. O agente consegue ler esse `.env`; as regras dele proíbem exibir os valores das chaves (`references/exchange-connect.md`).
- **Os valores a investir e a retomada do trading ficam por sua conta,** na página Auto trading (Trading automático) do app para desktop ou no espaço de trabalho web. O agente se recusa a fazer isso, mesmo que você peça; a única coisa que ele sempre pode fazer sozinho é acionar o kill switch.
- **No app para desktop, as ordens só saem enquanto o Blave está aberto.** Depois de fechar e abrir de novo, o trading continua pausado até você clicar em **Start trading** (Iniciar trading).
- **Verifica antes de relatar:** a ordem é consultada de volta na exchange antes de o agente dizer que ela foi enviada, e cada tentativa fica registrada em `state/audit.jsonl`.
- Um backtest descreve o passado. MCPT e varreduras de parâmetros diminuem a chance de você estar olhando para sorte; não a eliminam. Nada aqui constitui recomendação de investimento, e operar pode fazer você perder todo o seu dinheiro.

## Política de assinatura de código

A versão para Windows ainda não tem assinatura de código: solicitamos o programa de código aberto da [SignPath Foundation](https://signpath.org) e, até a aprovação, o instalador do Windows não é assinado. Depois de aprovado: assinatura de código gratuita no Windows fornecida pela [SignPath.io](https://signpath.io), com certificado da SignPath Foundation. As versões são compiladas pelo workflow público do GitHub Actions deste repositório a partir de um commit com tag; cada pedido de assinatura é aprovado pelo dono do repositório. Papéis: autores e revisores, os mantenedores com permissão de escrita; aprovador, o dono do repositório. Este programa não transferirá nenhuma informação a terceiros, exceto conforme descrito na [política de privacidade](https://blave.org/disclaimer/pt/privacy_policy). A versão para macOS é assinada e notarizada com a identidade Apple da própria Blave.

## Licença

**Apache-2.0** — veja [`LICENSE`](LICENSE) e [`NOTICE`](NOTICE). Você pode usar, modificar e redistribuir, inclusive comercialmente; uma concessão de patentes está incluída. "Blave" e o logotipo da Blave são marcas: renomeie o seu fork.

**As estratégias que você escreve são suas.** Tudo dentro de `strategies/` não faz parte deste projeto, e a licença não se estende a isso. As partes pagas — servidores na nuvem, dados de mercado e o proxy de LLM da Blave — são serviços da blave.org e não estão neste repositório.

Claude Code e Codex são produtos de seus respectivos donos. O Blave Agent não é afiliado a eles nem endossado por eles.

---

## Para mantenedores e máquinas existentes

As notas para mantenedores estão na versão em inglês: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
