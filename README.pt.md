# Blave Agent

**Espaço de trabalho quant**

## Transforme seu agente em um quant

Grátis e de código aberto. Conecte seu Claude Code ou Codex. Você descreve a ideia; ele escreve a estratégia, roda o backtest e opera ao vivo.

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | **Português** | [Tiếng Việt](README.vi.md)

> Esta tradução foi feita a partir do README em inglês no commit [`0d0b880`](https://github.com/Blave-TW/blave-agent/blob/0d0b880/README.md) e cobre só as seções que mudam pouco. Novidades, exchanges e dados, nuvem, estrutura do repositório, como contribuir e as notas para mantenedores estão na [versão em inglês](README.md). Se algo divergir, vale o original em inglês.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Baixar para macOS](https://github.com/Blave-TW/blave-agent/releases/latest) · [Baixar para Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) · [Início rápido (a partir do código-fonte)](#quick-start) · [Continue rodando com o PC desligado](https://blave.org/agent/pt)

Se for útil, dê uma estrela ao repositório, e ative Watch › Releases para saber de cada versão nova.

## O que o torna diferente

### Backtests que verificam overfitting e usam taxas reais

Overfitting: parâmetros que só por acaso se encaixam nos dados passados.

- Todo backtest de Tipo A roda por padrão um teste de permutação de Monte Carlo (MCPT, `lib/validation.py`) e registra um valor p: dados embaralhados poderiam ter se saído tão bem?
- Uma varredura de parâmetros (`lib/param_scan.py`) procura um platô de parâmetros que funcionam todos, não a melhor célula isolada.
- Um walk-forward móvel (`lib/walk_forward.py`) mede o desempenho fora da amostra.
- A taxa deve corresponder à do mercado real. Com taxa 0, `lib/quality_check.py` emite um aviso, mas não obriga a mudá-la.
- Por padrão, uma ideia recebe um único backtest. Um resultado ruim é relatado como está; o agente não reajusta os parâmetros às escondidas até os números ficarem bonitos (veja *Iteration Brakes* em [`AGENTS.md`](AGENTS.md)).

### Veja se ao vivo roda o código que passou pelo backtest

Um backtest fixa uma versão da estratégia. Se o código que roda ao vivo deixar de corresponder a essa versão, a estratégia é sinalizada: o espaço de trabalho web mostra "Ao vivo · arquivo alterado" em vez de um simples "Ao vivo". O sinal não impede a estratégia de rodar. Só se aplica aos tipos de estratégia que passam por backtest (Tipo A e C), e só a estratégias que têm versões.

### Nenhum LLM no ciclo de ordens

O agente faz a pesquisa e escreve o código. As execuções agendadas são código determinístico em um agendador; `manager/reconciler.py` leva a conta em direção às posições-alvo. Um kill switch (`state/HALT`) bloqueia nova exposição na camada da biblioteca de ordens, enquanto fechamentos e stops continuam passando.

### Relatórios que leem as notícias primeiro

Peça um resumo matinal, um relatório de fechamento do mercado, um resumo de um único ativo ou um relatório de pesquisa. O agente lê as notícias antes de escrever — em pelo menos três sites diferentes — e cada gráfico vem da série de dados real, nunca da memória do modelo. Cada relatório termina com um resumo e uma condição que provaria que a leitura dele está errada. O mapa de liquidações desenha em duas camadas, cada uma identificada, o que de fato foi liquidado e a estimativa do modelo.

### Um navegador que você pode acompanhar

Quando o agente lê a web, ele usa o navegador integrado do app: a página que ele está lendo aparece na sua tela, não em um processo oculto. Páginas de conta das exchanges e endereços de redes privadas são bloqueados. Uma URL de um site que ele não visitou nesta rodada, com parâmetros longos, para e pergunta a você antes de abrir.

<a id="quick-start"></a>

## Início rápido (a partir do código-fonte)

Você precisa de:

- macOS 13 ou superior. O app empacotado é um build universal: Apple Silicon e Intel, um único download.
- Ou Windows 10 ou 11, x64 (as versões que o Electron 44 suporta; ARM não testado). O instalador ainda não tem assinatura de código, então o Windows avisa na primeira instalação: clique no link abaixo do texto e depois no botão novo que aparece embaixo.
- Node.js 22.12 ou superior, com npm (`shell/package.json` › `engines`)
- `python3` no seu `PATH` (`python` no Windows). O app empacotado traz o próprio Python 3.12; rodando a partir do código-fonte, o Python do seu sistema é usado para criar o venv.
- Claude Code ou Codex instalado e com login feito, ou uma conta Blave

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

No Windows, no PowerShell (`npm.cmd` funciona mesmo quando a política de execução do PowerShell bloqueia o script `npm`):

```powershell
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent\shell
npm.cmd install
npm.cmd start
```

Na primeira abertura, você escolhe o que move o agente:

- **Seu próprio Claude Code ou Codex.** Não precisa de conta Blave, e a Blave não cobra nada pela IA. O app só inicia o CLI; suas credenciais do Claude Code ou do Codex ficam com ele.
- **Blave AI.** Entre com uma conta Blave; cobrada por uso.

Depois, descreva uma ideia. Por exemplo:

- "Faça o backtest de BTCUSDT no gráfico de 4h: comprado quando a SMA de 20 períodos cruzar acima da SMA de 60, fora do mercado quando cruzar de volta para baixo. Use uma taxa de 0.05% por lado."
- "Monte um portfólio de BTC, ETH e SOL com pesos iguais, rebalanceado toda semana, e faça o backtest."
- "Varra os dois comprimentos de SMA dessa estratégia e me mostre onde está o platô."

Antes de escrever código, o agente classifica cada ideia em um de três tipos:

| Tipo | O que é | Backtest |
|---|---|---|
| A | Um símbolo fixo em um intervalo fixo; uma posição (comprado / vendido / fora) | Obrigatório |
| C | Um portfólio: N símbolos e um vetor de pesos que soma no máximo 1, rebalanceado conforme um calendário | Obrigatório |
| B | Todo o resto: screeners, grids, arbitragem, alertas, execução pontual | Nenhum |

A interface segue o idioma do sistema (inglês ou chinês tradicional). Para forçar: `BLAVE_LANG=en npm start` (PowerShell: `$env:BLAVE_LANG="en"; npm.cmd start`).

## Novidades

As novidades estão na versão em inglês: [README.md › News](README.md#news)

## Segurança e limites

- **Onde ficam as chaves da exchange depende de onde você usa o agente.** App para desktop: no `.env` do espaço de trabalho no seu computador (`~/Blave/workspace/.env` no macOS, `%USERPROFILE%\Blave\workspace\.env` no Windows). Servidor na nuvem: no `.env` do espaço de trabalho no seu próprio servidor dedicado. Uma exchange vinculada pela página web: a Blave guarda a chave criptografada. O agente consegue ler o `.env` do espaço de trabalho; as regras dele proíbem exibir os valores das chaves (`references/exchange-connect.md`). Conceda à chave apenas permissões de leitura + trading, nunca de saque. Uma chave com permissão de saque é recusada na conexão (Binance, OKX, BingX, Bybit; igual no app para desktop, no servidor na nuvem e na página web). A Gate.io não informa essa permissão, então confira essa você mesmo.
- Os valores a investir e a retomada do trading ficam por sua conta: na página Trading automático do app para desktop, ou no espaço de trabalho web para um servidor na nuvem. O agente se recusa a fazer isso por você, mesmo que você peça. A única coisa que ele sempre pode fazer sozinho é acionar o kill switch.
- No app para desktop, as ordens só saem enquanto o Blave está aberto; depois de fechar e abrir de novo, o trading continua pausado até você clicar em Iniciar trading.
- O agente verifica antes de relatar: relê um arquivo depois de editá-lo e consulta a ordem na exchange antes de dizer que ela foi enviada. Cada tentativa de ordem fica registrada em `state/audit.jsonl`.
- Um backtest descreve o passado. Ele não prevê nem garante resultados futuros. MCPT verifica se um resultado é estatisticamente significativo, e as varreduras de parâmetros verificam se há overfitting; ambos só diminuem a chance de o backtest te enganar, e nenhum a elimina.
- Nada aqui constitui recomendação de investimento. Operar pode dar prejuízo, inclusive perder tudo.

## Política de assinatura de código

A versão para Windows ainda não tem assinatura de código: solicitamos o programa de código aberto da [SignPath Foundation](https://signpath.org) e, até a aprovação, o instalador do Windows não é assinado. Depois de aprovado: assinatura de código gratuita no Windows fornecida pela [SignPath.io](https://signpath.io), com certificado da SignPath Foundation. As versões são compiladas pelo workflow público do GitHub Actions deste repositório a partir de um commit com tag; cada pedido de assinatura é aprovado pelo dono do repositório. Papéis: autores e revisores, os mantenedores com permissão de escrita; aprovador, o dono do repositório. Este programa não transferirá nenhuma informação a terceiros, exceto conforme descrito na [política de privacidade](https://blave.org/disclaimer/pt/privacy_policy). A versão para macOS é assinada e notarizada com a identidade Apple da própria Blave.

## Licença

**Apache-2.0** — veja [`LICENSE`](LICENSE) e [`NOTICE`](NOTICE). Você pode usar, modificar e redistribuir, inclusive comercialmente; uma concessão de patentes está incluída. "Blave" e o logotipo da Blave são marcas: renomeie o seu fork.

**As estratégias que você escreve são suas.** O que você (ou o agente em seu nome) escrever dentro de `strategies/` não faz parte deste projeto, e a licença não se estende a isso.

As partes pagas não estão neste repositório: servidores na nuvem, dados de mercado e o proxy de LLM da Blave são serviços da blave.org. Este código roda no seu próprio computador sem custo, com a sua própria assinatura de IA e as suas próprias fontes de dados.

Claude Code e Codex são produtos de seus respectivos donos. O Blave Agent não é afiliado a eles nem endossado por eles.

---

## Para mantenedores e máquinas existentes

As notas para mantenedores estão na versão em inglês: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
