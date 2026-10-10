# Blave Agent

## Espacio de trabajo quant para agentes de IA

Crea, haz backtest y opera estrategias en vivo con Claude Code o Codex. Gratis y de código abierto.

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **Español** | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

> Esta traducción parte del README en inglés en el commit [`08cf860`](https://github.com/Blave-TW/blave-agent/blob/08cf860/README.md) y cubre solo las secciones que cambian poco. Las novedades, los exchanges y datos, la nube, la estructura del repositorio, cómo contribuir y las notas para mantenedores están en la [versión en inglés](README.md). Si algo no coincide, prevalece el original en inglés.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Descargar para macOS](https://github.com/Blave-TW/blave-agent/releases/latest) · [Descargar para Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) · [Inicio rápido (desde el código fuente)](#quick-start) · [Que siga funcionando con el PC apagado](https://blave.org/agent/es)

Si te resulta útil, dale una estrella al repositorio, y activa Watch › Releases para enterarte de cada versión nueva.

## Qué lo hace diferente

### Backtests que comprueban el sobreajuste y usan comisiones reales

Sobreajuste: parámetros que solo por casualidad encajan con los datos pasados.

- Cada backtest de Tipo A ejecuta por defecto una prueba de permutación de Monte Carlo (MCPT, `lib/validation.py`) y registra un valor p: ¿unos datos barajados podrían haberlo hecho igual de bien?
- Un barrido de parámetros (`lib/param_scan.py`) busca una meseta de parámetros que funcionen todos, no la mejor celda aislada.
- Un walk-forward móvil (`lib/walk_forward.py`) mide el rendimiento fuera de muestra.
- La comisión debería corresponder al mercado real. Con una comisión de 0, `lib/quality_check.py` avisa, pero no obliga a cambiarla.
- Por defecto, una idea recibe un solo backtest. Un mal resultado se informa tal cual; el agente no reajusta los parámetros a escondidas hasta que los números se vean bien (consulta *Iteration Brakes* en [`AGENTS.md`](AGENTS.md)).

### Comprueba si en vivo corre el código que pasó el backtest

Un backtest fija una versión de la estrategia. Si el código que corre en vivo ya no coincide con esa versión, la estrategia queda marcada: el espacio de trabajo web muestra «En vivo · archivo modificado» en lugar de un simple «En vivo». La marca no detiene la estrategia. Solo se aplica a los tipos de estrategia que llevan backtest (Tipo A y C), y solo a estrategias que tienen versiones.

### Informes que primero leen las noticias

Pide un resumen matutino, un informe de cierre de mercado, un resumen de un solo símbolo o un informe de investigación. El agente lee las noticias antes de escribir —al menos en tres sitios distintos— y cada gráfico sale de la serie de datos real, nunca de la memoria del modelo. Cada informe termina con un resumen y una condición que demostraría que su lectura es errónea. El mapa de liquidaciones dibuja en dos capas, cada una con su etiqueta, lo que de verdad se liquidó y lo que estima el modelo.

### Un navegador que puedes ver

Cuando el agente lee la web, usa el navegador integrado de la app: la página que está leyendo aparece en tu pantalla, no en un proceso oculto. Las páginas de cuenta de los exchanges y las direcciones de redes privadas están bloqueadas. Una URL de un sitio que no ha visitado en esta ronda y que lleva parámetros largos se detiene y te pregunta antes de abrirse.

<a id="quick-start"></a>

## Inicio rápido (desde el código fuente)

Necesitas:

- macOS 13 o superior. La app empaquetada es una compilación universal: Apple Silicon e Intel, una sola descarga.
- O Windows 10 u 11, x64 (las versiones que soporta Electron 44; ARM no está probado). El instalador aún no tiene firma de código, así que Windows avisa en la primera instalación: haz clic en el enlace que aparece debajo del texto y luego en el botón nuevo que aparece abajo.
- Node.js 22.12 o superior, con npm (`shell/package.json` › `engines`)
- `python3` en tu `PATH` (`python` en Windows). La app empaquetada trae su propio Python 3.12; al ejecutar desde el código fuente se usa el Python de tu sistema para crear el venv.
- Claude Code o Codex instalado y con sesión iniciada, una clave de API de DeepSeek de pago por uso, o una cuenta de Blave

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

En Windows, en PowerShell (`npm.cmd` funciona aunque la directiva de ejecución de PowerShell bloquee el script `npm`):

```powershell
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent\shell
npm.cmd install
npm.cmd start
```

En el primer inicio eliges qué impulsa al agente:

- **Tu propio Claude Code o Codex.** No hace falta una cuenta de Blave, y Blave no cobra nada por la IA. La app solo lanza el CLI; tus credenciales de Claude Code o Codex se quedan con él.
- **Tu propia clave de API (DeepSeek).** Pega una clave de pago por uso; DeepSeek te cobra directamente y Blave no cobra nada por la IA. La clave se queda en el llavero de este equipo (cifrada en Windows) y el agente nunca la ve: la app reenvía sus solicitudes en local.
- **Blave AI.** Inicia sesión con una cuenta de Blave; se cobra por uso.

Después, describe una idea. Por ejemplo:

- «Haz un backtest de BTCUSDT en el gráfico de 4h: largo cuando la SMA de 20 periodos cruce por encima de la SMA de 60, fuera del mercado cuando vuelva a cruzar por debajo. Usa una comisión del 0.05% por lado.»
- «Arma un portafolio de BTC, ETH y SOL con pesos iguales, rebalanceado cada semana, y haz su backtest.»
- «Barre las dos longitudes de SMA de esa estrategia y muéstrame dónde está la meseta.»

Antes de escribir código, el agente clasifica cada idea en uno de tres tipos:

| Tipo | Qué es | Backtest |
|---|---|---|
| A | Un símbolo fijo en un intervalo fijo; una posición (largo / corto / fuera) | Obligatorio |
| C | Un portafolio: N símbolos y un vector de pesos que suma como máximo 1, rebalanceado según un calendario | Obligatorio |
| B | Todo lo demás: screeners, grids, arbitraje, alertas, ejecución puntual | Ninguno |

La interfaz sigue el idioma del sistema (inglés o chino tradicional). Para forzarlo: `BLAVE_LANG=en npm start` (PowerShell: `$env:BLAVE_LANG="en"; npm.cmd start`).

## Novedades

Las novedades están en la versión en inglés: [README.md › News](README.md#news)

## Seguridad y límites

- **Dónde viven las claves del exchange depende de dónde uses el agente.** App de escritorio: en el `.env` del espacio de trabajo en tu ordenador (`~/Blave/workspace/.env` en macOS, `%USERPROFILE%\Blave\workspace\.env` en Windows). Servidor en la nube: en el `.env` del espacio de trabajo de tu propio servidor dedicado. Un exchange vinculado desde la página web: Blave guarda la clave cifrada. El agente puede leer el `.env` del espacio de trabajo; sus reglas le prohíben mostrar los valores de las claves (`references/exchange-connect.md`). Otorga a la clave solo permisos de lectura + trading, nunca de retiro. Una clave con permiso de retiro se rechaza al conectarla (Binance, OKX, BingX, Bybit; igual en la app de escritorio, el servidor en la nube y la página web). Gate.io no informa de ese permiso en absoluto, así que compruébalo tú mismo.
- Los montos a invertir y la reanudación del trading los haces tú: en la página Trading automático de la app de escritorio, o en el espacio de trabajo web si usas un servidor en la nube. El agente se niega a hacerlo por ti, aunque se lo pidas. Lo único que siempre puede hacer por su cuenta es activar el kill switch. El kill switch (`state/HALT`) bloquea nueva exposición; los cierres y stops siguen pasando.
- En la app de escritorio, las órdenes solo salen mientras Blave está abierto; después de cerrarlo y volver a abrirlo, el trading queda en pausa hasta que pulses Iniciar trading.
- El agente verifica antes de informar: vuelve a leer un archivo después de editarlo y consulta una orden en el exchange antes de decir que se colocó. Cada intento de orden queda registrado en `state/audit.jsonl`.
- Un backtest describe el pasado. No predice ni garantiza resultados futuros. MCPT comprueba si un resultado es estadísticamente significativo, y los barridos de parámetros comprueban si hay sobreajuste; ambos solo reducen la probabilidad de que el backtest te engañe, y ninguno la elimina.
- Nada de esto constituye asesoramiento de inversión. Operar puede hacerte perder dinero, incluso todo.

## Política de firma de código

La versión de Windows aún no tiene firma de código: hemos solicitado el programa de código abierto de [SignPath Foundation](https://signpath.org) y, hasta que lo aprueben, el instalador de Windows no está firmado. Una vez aprobado: firma de código gratuita en Windows proporcionada por [SignPath.io](https://signpath.io), con certificado de SignPath Foundation. Las versiones se compilan con el flujo público de GitHub Actions de este repositorio a partir de un commit con tag; cada solicitud de firma la aprueba el propietario del repositorio. Roles: autores y revisores, los mantenedores con permiso de escritura; aprobador, el propietario del repositorio. Este programa no transferirá ninguna información a terceros, salvo lo descrito en la [política de privacidad](https://blave.org/disclaimer/es/privacy_policy). La versión de macOS está firmada y notarizada con la identidad de Apple propia de Blave.

## Licencia

**Apache-2.0**: consulta [`LICENSE`](LICENSE) y [`NOTICE`](NOTICE). Puedes usarlo, modificarlo y redistribuirlo, también con fines comerciales; incluye una concesión de patentes. «Blave» y el logotipo de Blave son marcas comerciales: cambia el nombre de tu fork.

**Las estrategias que escribes son tuyas.** Lo que tú (o el agente en tu nombre) escribas dentro de `strategies/` no forma parte de este proyecto y la licencia no lo alcanza.

Las partes de pago no están en este repositorio: los servidores en la nube, los datos de mercado y el proxy de LLM de Blave son servicios de blave.org. Este código se ejecuta en tu propio ordenador sin costo, con tu propia suscripción de IA y tus propias fuentes de datos.

Claude Code y Codex son productos de sus respectivos propietarios. Blave Agent no está afiliado a ellos ni cuenta con su respaldo.

---

## Para mantenedores y máquinas existentes

Las notas para mantenedores están en la versión en inglés: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)
