<p align="center">
  <img src="docs/logo.png" alt="" width="180">
</p>

<h1 align="center">GamifyDesktop</h1>

<p align="center">
  <a href="https://discord.gg/BC8fF2nr4y"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue?style=for-the-badge" alt="License: GPLv3"></a>
</p>

**GamifyDesktop** (formerly GenieEngine) is an AI-powered game engine that lets you build commercial-quality video games with AI. Games are real [Godot 4](https://godotengine.org) projects under the hood, and
the AI assistant is powered by OpenAI's [Codex](https://github.com/openai/codex) agent. Everything — the engine,
git, and the AI agent — ships inside the app, so there's nothing to install or configure: sign in with your
[Gamify](https://trygamify.io) account, or bring an API key for your own models.

![GamifyDesktop running a game built with it, chat on the right, embedded game view on the left](docs/screenshot.png)
*GamifyDesktop is capable of creating commercial-grade games. [Play demo here](https://legojazz.itch.io/survival-fortress).*

## Free and Open Source

GamifyDesktop is completely free and open source under the permissive GPLv3 license. No strings
attached, no royalties. Games you create are yours. We follow the very permissive Open Source model
of Godot, which is a key technology that enables GamifyDesktop.

## Quick Install

Download the latest release from the [releases page](https://github.com/GamifyEngine/GamifyDesktop/releases/latest):

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon & Intel) | the `.dmg` |
| Windows | the `Setup.exe` — note: I don't have a Windows machine, so this is untested |
| Linux | the `.AppImage` — note: I don't have a Linux machine, so this is untested |

Releases up to 0.1.2 were published under the name GenieEngine. The first launch of GamifyDesktop
picks up their settings, API keys and chats automatically.

## Why GamifyDesktop (vs. a coding agent like Claude Code)

Claude Code and Codex are excellent general-purpose coding agents — but they assume you already
have a dev environment, are comfortable in a terminal, can easily create art assets, and can wire
up a game engine and an export process yourself. GamifyDesktop uses that same class of AI agent, but
packages it for one job: making a game.

- **The AI tests its own work** — through a built-in MCP harness, the assistant can run the game
  off-screen, send scripted input, take screenshots, and query game state — so it catches broken
  changes before telling you it's done, instead of you finding out later. You spend less time
  debugging, and more time in the creative process.

- **Art, not just code** — 2D and 3D asset generation is built into the same chat, so sprites,
  icons, and models land straight in your project alongside the code that uses them. Note: I plan
  to add audio (music and sound effects) generation in the future as well.

- **One-click export** — ship to all six Godot platforms without touching an export pipeline
  yourself (MacOS, Linux, Windows, iOS, Android, Web).

Claude Code is the right tool if you're a developer who wants an agent inside your existing
workflow. GamifyDesktop is for anyone who wants to make a game, with the same caliber of AI doing the
work end-to-end.

## Getting started

### 1. Install and create a project

Install GamifyDesktop and open it. From the welcome screen, click **New Game**.

### 2. Connect your AI assistant

On first launch, GamifyDesktop shows a **Connect your AI assistant** screen (reopen it any time via
the gear icon in the title bar). The assistant runs on one of two options, each a tab — the one with
the filled dot is what **Save** applies:

**Gamify Account** — the easy way, no API keys. Click **Sign in with Gamify**: your browser opens
[trygamify.io](https://trygamify.io), you sign in with Apple (the same Apple ID as in the Gamify iPhone
app, if you use it), and GamifyDesktop signs you in by itself as soon as you're done. The assistant then
runs on the models Gamify picks, and 2D art generation is included; both are paid for with your
account's credits (new accounts start with free credits). The tab shows who is signed in and the
credits left; **Manage your account** opens your account page on trygamify.io.

**Your Own Models** — bring your own endpoints and keys. Two model slots power the assistant. Each
slot takes an **API endpoint** that speaks the OpenAI Responses API (defaults to **OpenRouter**,
`https://openrouter.ai/api/v1`), a **Model**, an **API key**, and **Thinking** / **Reasoning
effort** settings. Keys are stored locally by GamifyDesktop and never exposed to the assistant itself. Grab a key from
[openrouter.ai/keys](https://openrouter.ai/keys) and paste it into the Medium slot — the Large slot
reuses it if you leave its key blank. Both models must accept image input: the assistant reads the
images you attach and play-tests your game with screenshots itself. Recommended setup:

| Slot | What it does | Recommended model | Thinking | Reasoning effort |
| --- | --- | --- | --- | --- |
| **Chat model — Medium** | The everyday model that plans and writes your game's code | `deepseek/deepseek-v4.1-flash` | Enabled | Max |
| **Chat model — Large** | A heavyweight model for tough tasks — switch to it from the dropdown in the chat box | `moonshotai/kimi-k2.7-code` | Enabled | Max |

On a Gamify account the chat box has no Medium/Large switch: Gamify picks the model.

**Asset generation** *(optional)* — two more tabs let the assistant create art straight into your
project's assets folder, whichever option runs the assistant:

| Tab | What it enables | Credentials |
| --- | --- | --- |
| **2D Assets** | Sprites, icons, and UI as transparent 1024×1024 PNGs | Included with a Gamify account; with your own models, an OpenAI API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (gpt-image-1.5) |
| **3D Assets** | 3D models, via Tencent's Hunyuan 3D | **Tencent SecretId** and **SecretKey** from the Tencent Cloud console, under Access Management (CAM) → API Keys — see [Tencent's Hunyuan-to-3D docs](https://www.tencentcloud.com/document/product/1284/75287) |

Skipping a tab just disables that capability; the assistant will explain what it can't do rather
than failing silently.

### 3. Build your game

Describe what you want in the chat — the assistant writes the code, and you can hit **Run** any
time to play the current build right in the window. Ask it for art (2D or 3D) too ("give the player a
pixel-art sprite").

### 4. Shipping your game

When you're ready to ship, click **Export** and pick any combination of Godot's six platforms —
Godot's export templates download automatically the first time you export: **Windows**, **macOS**, 
**Linux**, **Web**, **Android**, and **iOS**.

## Development

```bash
npm install        # also downloads the bundled Godot and Codex engines
npm run dev
```

To work against a local Gamify backend instead of trygamify.io (see the GamifyPlatform repository's
`backend/dev.sh`), start the app with `GAMIFY_API_BASE=http://localhost:8000 npm run dev`; its sign-in
page then offers the backend's developer sign-in.
