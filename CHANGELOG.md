# Changelog

All notable changes to GenieEngine are documented here.

## [Unreleased]

### Changed
- The separate image model is gone: the chat model now reads attached images and game screenshots itself, and the game-tester subagent runs on whichever chat model (Medium or Large) the current turn uses. Both chat models must therefore accept image input; the AI settings panel shows two model sections instead of three. Recommended models are now `deepseek/deepseek-v4.1-flash` (Medium) and `moonshotai/kimi-k2.7-code` (Large). The old image-model configuration and the image-reader subagent are removed from existing OpenCode configs automatically; models on custom (non-OpenRouter) endpoints are declared image-capable so screenshots are no longer stripped before reaching them
- The bundled OpenCode CLI is updated from 1.17.13 to 1.18.30, and `npm run setup` now replaces bundled engines whose pinned version changed instead of keeping the previously downloaded copy

## [0.1.1] - 2026-07-10

### Added
- The chat agent now runs on two configurable models instead of one: Medium (default: deepseek/deepseek-v4-pro) for everyday work, and Large (default: z-ai/glm-5.2) for tough tasks that need extra juice but may cost more. A dropdown in the chat box switches between them mid-conversation — the full chat history carries over. The image / game-testing model stays its own separate configuration (default: moonshotai/kimi-k2.7-code)
- Every model in the AI settings can now set Thinking (enabled/disabled) and Reasoning effort (low/medium/high/xhigh/max), sent with each request as the standard OpenAI-format `thinking` / `reasoning_effort` fields; the default sends nothing and leaves the model on its own behavior
- Watch the assistant play-test live: while an AI test run is in progress, the test card shows a live view of the off-screen game as the assistant plays it, letterboxed and resizing cleanly with the window (macOS; other platforms keep showing the latest captured screenshot). The live view is display-only, so watching never interferes with the run
- The game viewer now shows a live FPS counter while your game runs — green normally, orange below 50 FPS, red below 30 — and per-minute frame stats (min / max / avg / 1% low / 0.1% low) are logged to `.genieengine/perf.log`, giving the assistant real frame-rate history when diagnosing performance problems
- Chat attachments now go beyond images and small text files: attach `.zip` asset packs, 3D models (`.glb`, `.gltf`, `.obj`, `.fbx`, `.dae`, `.stl`, `.blend`), audio, fonts, or entire folders — via the new folder button or drag-and-drop, up to 512 MB. They're copied into the project so the assistant can unpack them and wire the assets into the game
- New `/undo` and `/redo` chat commands: `/undo` takes back your last message together with the file changes that turn made and drops the message back into the composer for editing; `/redo` restores it — conversation and project files both. Undo history survives app restarts
- The assistant now treats the project's AGENTS.md as persistent memory — say "remember …" or settle a lasting decision (art direction, control scheme, conventions) and it records a short note there that carries into future sessions

### Fixed
- Updating the chat model's API key silently overwrote the image model's stored key whenever both models pointed at the same endpoint (they shared one credential slot), and changing the chat endpoint could strand the image credential entirely. Every model now keeps its own credential slot; leaving a key blank to share another section's key copies it instead of aliasing it
- The game-testing subagent could probe a game for 10+ minutes behind a motionless chat, looking hung until the user cancelled. AI test runs now have a per-run budget (~40 game tool calls / 8 minutes) with an early wrap-up warning, and subagent tool activity is shown live in the chat as labelled chips
- Test screenshots are now downscaled to 1024-wide JPEGs before being sent to the model — full-size retina PNGs accumulating in the test conversation made every step slower and could exceed the provider's request-size limit mid-run (the on-disk copy stays full resolution)
- A transient provider failure mid-response (server 5xx/429, overload, gateway errors) used to kill the turn partway through. The app now automatically resumes the same session and the response continues where it left off, with up to two retries — distinct from the manual "Continue" button for lost internet
- A brief network hiccup on the first message after reopening a project no longer makes the assistant silently forget the conversation and start a fresh one — session verification is retried, and only a definitive "session gone" answer from the server starts over. Rapidly switching projects mid-save could also detach a chat from its session; it no longer does
- A conversation that outgrew the model's context window used to dead-end: every further message failed with the same error. The chat now rolls over to a fresh session automatically, seeded with a recap of the recent conversation, and keeps going — with a clear error only if a single message is too large even for a fresh session
- An auto-denied out-of-project file access used to halt the whole agent run, leaving the chat frozen until the user typed something. Denials now return to the model as ordinary tool errors it can route around, and AI test screenshots moved from `~/Library` into the project (`.genieengine/test-shots/`) so reading them never trips the permission system in the first place
- AI shell commands that strayed outside the project could trigger macOS "would like to access your Desktop / Photos / …" prompts. The assistant now runs under a macOS sandbox profile that silently denies personal folders (Desktop, Downloads, Photos, iCloud Drive, `.ssh`, and similar) while keeping the project fully accessible — no system prompts, and commands that stage files in the OS temp dir no longer fail
- The assistant's game-testing and asset-generation tools silently stopped working when the app was launched from a mounted `.dmg` or when more than one copy of the app was running — each instance now gets its own tool bridge, and the sandbox permits the app bundle wherever it lives
- Opening Settings, Export, or the first-run setup while a game was embedded left the live game view punched through on top of the dialog — the native game layer now hides whenever a modal is open, including games that finish launching behind one

### Changed
- OpenGenie is now GenieEngine — the app, installer, and per-project state directory (`.genieengine/`) all use the new name
- AGENTS.md is now fully yours: new projects get a short, editable file for your own notes, while GenieEngine's build rules ship with the app (staying current with each release) and are injected at chat time. Projects still carrying the old app-generated AGENTS.md are slimmed down automatically on open; any file you've edited is left untouched
- Games no longer flash the Godot engine splash screen on launch — new projects boot straight into their first scene, and export fixes up older projects that never chose a splash of their own. A custom splash you set yourself is respected
- The chat input box now grows with your message up to a comfortable maximum instead of staying a single line, and snaps back after sending

## [0.1.0] - 2026-07-06

### Added
- Native Godot game view embedded directly in the app window, with aspect-ratio presets, letterboxing, and a resizable output console
- AI chat panel backed by a per-project OpenCode server, with live-streamed responses, tool-activity indicators, file/image attachments, and slash commands
- First-run AI setup overlay — works with OpenRouter out of the box or any OpenAI-compatible endpoint
- The assistant can test games itself via MCP: off-screen runs, scripted input, screenshots, GDScript state probes, and console logs
- One-click export to all six Godot platforms, with export templates downloaded on demand
- Workspace sidebar with a VS Code-style file explorer and a full Git panel (stage/commit/push/pull, remotes, history)
- Buttons to open the current project directly in VS Code or the Godot editor
- "Advanced mode" toggle that reveals the ECS viewer, Files sidebar, Git sidebar, and console output for engineers, while keeping the default view simple
- 2D asset generation (sprites, icons, textures) via OpenAI image generation, saved straight into the project
- 3D asset generation via Tencent Hunyuan 3D, saved straight into the project
- ECS graph viewer showing entities, components, and systems as a linked diagram
- Interactive "question" tool — the assistant can ask multiple-choice questions mid-turn instead of guessing
- Per-project chat history and input recall (↑ / ↓) that persist across app restarts
- "Thinking…" indicator now shows a live elapsed-time counter when a model's reasoning text isn't available
- A turn interrupted by a lost internet connection can be resumed with "Continue" once back online

### Fixed
- Packaged builds could fail to launch because compiled code wasn't bundled into the app
- Project names containing control characters could inject arbitrary GDScript into `project.godot`
- Godot export presets set up in the editor (signing, keystores, icons) were being overwritten instead of merged on export
- Exporting only worked correctly on macOS — Windows and Linux now extract export templates with their own native tools
- Stopping a game run could be undone by a delayed exit event from a previously stopped run
- Links in the AI chat no longer navigate the whole app UI away — they now open in the system browser
- Running multiple GenieEngine instances no longer lets the assistant's game-testing tools cross-talk between them
- Restoring a saved chat session now correctly resumes the conversation instead of silently starting a new one
- macOS window traffic lights disappearing in native fullscreen no longer leave stray padding in the title bar

### Changed
- AI provider setup now accepts any OpenAI-compatible endpoint rather than a fixed list of providers
- App and installer now use a custom GenieEngine icon, including the macOS `.dmg` file itself
