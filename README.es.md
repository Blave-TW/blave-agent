<div align="center">

<img src="docs/icon.png" width="80" alt="">

# Blave Agent

**Espacio de trabajo quant para agentes de IA**<br>
Crea, haz backtest y opera estrategias en vivo con Claude Code o Codex. Gratis y de código abierto.

<a href="https://github.com/Blave-TW/blave-agent/releases"><img src="https://img.shields.io/github/v/release/Blave-TW/blave-agent?filter=desktop-*&label=latest&color=555" alt="Última versión"></a>

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **Español** | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

<a href="https://download.blave.org/desktop/mac/Blave-universal.dmg"><img src="docs/readme-dl-mac.es.png" alt="Descargar para Mac" width="241"></a>&nbsp;&nbsp; <a href="https://download.blave.org/desktop/win/Blave-Setup.exe"><img src="docs/readme-dl-win.es.png" alt="Descargar para Windows" width="241"></a>

</div>

> Traducido del README en inglés en el commit [`db5574d`](https://github.com/Blave-TW/blave-agent/blob/db5574d/README.md). Si algo no coincide, prevalece el original en inglés.

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

<p align="center"><a href="https://blave.org/docs/es">Documentación</a></p>

## Qué obtienes

- **Todas tus estrategias en una sola app.** Backtest, operaciones, barrido de parámetros y versiones de cada una.
- **Backtests que detectan el sobreajuste.** p-valor MCPT, meseta de parámetros y walk-forward.
- **Comisiones reales por defecto.** Una comisión de 0 genera un aviso.
- **Trading automático ya conectado.** Binance, OKX, Bybit, BingX, Gate.io, y futuros sobre índices de Taiwán en Windows.
- **Paper trading.** Sin claves.
- **Ideas de la web.** El agente lee unos pocos sitios y trae tres que puedes probar.
- **Elige tu IA.** Claude Code, Codex, una clave de DeepSeek o Blave AI.

![Una estrategia de ruptura de BTC en la app](docs/readme-backtest.png)

<p align="center">⭐ Si te ahorra un fin de semana de conexiones, dale una estrella. Ayuda a que otros traders lo encuentren.</p>

<a id="quick-start"></a>

## Inicio rápido

1. Descarga la versión para [macOS](https://download.blave.org/desktop/mac/Blave-universal.dmg) o [Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) y ábrela.
2. Elige tu IA.
3. Describe una idea:

> Haz un backtest de BTCUSDT en velas de 4h: largo cuando la SMA 20 cruce por encima de la SMA 60, sin posición cuando vuelva a cruzar. Comisión del 0,05% por lado.

<details><summary>Notas de plataforma</summary>

macOS 13+ (build universal) o Windows 10/11 x64. El instalador de Windows aún no está firmado: elige Más información › Ejecutar de todas formas.

</details>

<details><summary>Compilar desde el código fuente</summary>

Necesitas Node.js 22.12 o superior y Python 3 en tu `PATH`.

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

En Windows, ejecuta `npm.cmd install` y `npm.cmd start` en PowerShell.

</details>

## Seguridad

- **Solo tú puedes asignar fondos o reanudar el trading.** El agente solo puede detenerlo.
- **Cada orden se verifica con el exchange** y queda registrada en `state/audit.jsonl`.
- **Un backtest describe el pasado.** El trading puede hacerte perder todo tu dinero.

Exchanges y claves: [documentación](https://blave.org/docs/es/exchange_api) · Fuentes de datos: [cripto](https://blave.org/docs/es/data_crypto), [acciones de Taiwán](https://blave.org/docs/es/data_twstock)

## Ejecútalo en la nube (de pago)

Tus estrategias siguen funcionando con el PC apagado, y hablas con ellas desde la web o Telegram. [Planes](https://blave.org/agent/es)

## Novedades

Cada versión: [Releases](https://github.com/Blave-TW/blave-agent/releases). Usa Watch › Releases para recibir avisos.

## Para desarrolladores

<details><summary>Estructura del repositorio, tests, cómo contribuir</summary>

Empieza por `AGENTS.md`, luego `examples/README.md` y `references/lib.md`. En `tests/` hay un archivo por contrato. Antes de un PR, ejecuta los tests que cubren tu cambio y `pre-commit install`.

</details>

## Licencia

Apache-2.0. Las estrategias que escribes son tuyas. «Blave» es una marca comercial: cambia el nombre de tu fork.

Claude Code y Codex son productos de sus respectivos propietarios. Blave Agent no está afiliado a ellos ni cuenta con su respaldo.

## Política de firma de código

La versión de Windows aún no tiene firma de código: hemos solicitado el programa de código abierto de [SignPath Foundation](https://signpath.org) y, hasta que lo aprueben, el instalador de Windows no está firmado. Una vez aprobado: firma de código gratuita en Windows proporcionada por [SignPath.io](https://signpath.io), con certificado de SignPath Foundation. Las versiones se compilan con el flujo público de GitHub Actions de este repositorio a partir de un commit con tag; cada solicitud de firma la aprueba el propietario del repositorio. Roles: autores y revisores, los mantenedores con permiso de escritura; aprobador, el propietario del repositorio. Este programa no transferirá ninguna información a terceros, salvo lo descrito en la [política de privacidad](https://blave.org/disclaimer/es/privacy_policy). La versión de macOS está firmada y notarizada con la identidad de Apple propia de Blave.

---

## Para mantenedores y máquinas existentes

Las notas para mantenedores están en la versión en inglés: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
