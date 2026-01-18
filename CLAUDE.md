# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Openwork is a standalone desktop automation assistant built with Electron. The app hosts a local React UI (bundled via Vite), communicating with the main process through `contextBridge` IPC. The main process spawns the OpenCode CLI (via `node-pty`) to execute user tasks. Users provide their own API key (Anthropic, OpenAI, Google, or xAI) on first launch, stored securely in the OS keychain.

## Common Commands

```bash
pnpm dev                              # Run desktop app in dev mode (Vite + Electron)
pnpm dev:clean                        # Dev mode with CLEAN_START=1 (clears stored data)
pnpm build                            # Build all workspaces
pnpm build:desktop                    # Build desktop app only
pnpm lint                             # TypeScript checks
pnpm typecheck                        # Type validation
pnpm clean                            # Clean build outputs and node_modules
pnpm -F @accomplish/desktop test:e2e  # Playwright E2E tests
pnpm -F @accomplish/desktop test:e2e:ui    # E2E with Playwright UI
pnpm -F @accomplish/desktop test:e2e:debug # E2E in debug mode
```

## Architecture

### Monorepo Layout
```
apps/desktop/     # Electron app (main/preload/renderer)
packages/shared/  # Shared TypeScript types
```

### Desktop App Structure (`apps/desktop/src/`)

**Main Process** (`main/`):
- `index.ts` - Electron bootstrap, single-instance enforcement, `accomplish://` protocol handler
- `ipc/handlers.ts` - IPC handlers for task lifecycle, settings, onboarding, API keys
- `opencode/adapter.ts` - OpenCode CLI wrapper using `node-pty`, streams output and handles permissions (legacy mode)
- `opencode/server-adapter.ts` - OpenCode HTTP/SSE adapter for real-time streaming (default mode)
- `opencode/task-manager.ts` - Manages task execution, selects adapter mode based on settings
- `store/secureStorage.ts` - API key storage via `keytar` (OS keychain)
- `store/appSettings.ts` - App settings via `electron-store` (debug mode, streaming mode, onboarding state)
- `store/taskHistory.ts` - Task history persistence

**Preload** (`preload/index.ts`):
- Exposes `window.accomplish` API via `contextBridge`
- Provides typed IPC methods for task operations, settings, events

**Renderer** (`renderer/`):
- `main.tsx` - React entry with HashRouter
- `App.tsx` - Main routing + onboarding gate
- `pages/` - Home, Execution, History, Settings pages
- `stores/taskStore.ts` - Zustand store for task/UI state
- `lib/accomplish.ts` - Typed wrapper for the IPC API

### IPC Communication Flow
```
Renderer (React)
    ↓ window.accomplish.* calls
Preload (contextBridge)
    ↓ ipcRenderer.invoke
Main Process
    ↓ Native APIs (keytar, node-pty, electron-store)
    ↑ IPC events
Preload
    ↑ ipcRenderer.on callbacks
Renderer
```

### Key Dependencies
- `node-pty` - PTY for OpenCode CLI spawning (legacy mode)
- `keytar` - Secure API key storage (OS keychain)
- `electron-store` - Local settings/preferences
- `opencode-ai` - Bundled OpenCode CLI (multi-provider: Anthropic, OpenAI, Google, xAI, Ollama)

### Ollama Integration

The app supports running local LLMs via [Ollama](https://ollama.com). Key files:

- `main/ipc/handlers.ts` - Ollama connection testing and model discovery
- `main/opencode/config-generator.ts` - Generates OpenCode config with Ollama provider
- `main/opencode/server-adapter.ts` - Handles Ollama model variants with custom context windows
- `main/opencode/shared-server.ts` - Sets `OLLAMA_CONTEXT_LENGTH` environment variable

**Context Window Handling:**

Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) doesn't support `num_ctx` in request bodies. To work around this limitation, the app:

1. **Creates custom model variants** with `num_ctx` baked in via Ollama's `/api/create` endpoint
2. **Uses Modelfile syntax** to set `PARAMETER num_ctx` permanently for the variant
3. **Names variants clearly** (e.g., `qwen3:8b-ctx40k` for 40K context)

This ensures the context window setting persists across all requests, including follow-ups in the same session.

**Configuration Priority:**
1. User override (Settings → Context Length Override)
2. Model's reported context window (from Ollama `/api/show`)
3. Default fallback (32K)

See [docs/ollama-setup.md](docs/ollama-setup.md) for detailed Ollama configuration guide.

### Adapter Modes

The app supports two modes for communicating with OpenCode:

1. **Server Mode (default)** - Uses `opencode serve` HTTP API with Server-Sent Events (SSE) for real-time streaming. Provides true token-by-token streaming for model responses.

2. **CLI Mode (legacy)** - Uses `opencode run --format json` via PTY. Output is buffered and responses appear all at once.

Mode is controlled by the "Streaming Mode" toggle in Settings. When enabled, Server Mode is used.

### Streaming Architecture (Server Mode)

Key files for the streaming implementation:

- `main/opencode/shared-server.ts` - Manages a single shared OpenCode server instance
- `main/opencode/server-adapter.ts` - HTTP/SSE adapter for real-time communication
- `main/opencode/config-generator.ts` - Generates OpenCode `config.json` with provider settings

**Session Management:**

The server adapter maintains session persistence for multi-turn conversations:

1. First message creates a new session via `POST /session`
2. Session ID is stored and reused for follow-up messages
3. Messages are sent via `POST /session/{id}/message`
4. Responses stream back via SSE at `/event`

**SSE Event Types:**

| Event | Purpose |
|-------|---------|
| `session.updated` | Session metadata changes |
| `session.status` | busy/idle status |
| `message.updated` | Message content and token counts |
| `part.updated` | Streaming text chunks |
| `server.heartbeat` | Keep-alive ping |

**Configuration Generation:**

The `config-generator.ts` creates a dynamic OpenCode config with:
- Provider credentials from secure storage
- Model configurations with tool support flags
- Ollama model variants with context settings

## Code Conventions

- TypeScript everywhere (no JS for app logic)
- Use `pnpm -F @accomplish/desktop ...` for desktop-specific commands
- Shared types go in `packages/shared/src/types/`
- Renderer state via Zustand store actions
- IPC handlers in `src/main/ipc/handlers.ts` must match `window.accomplish` API in preload

### Image Assets in Renderer

**IMPORTANT:** Always use ES module imports for images in the renderer, never absolute paths.

```typescript
// CORRECT - Use ES imports
import logoImage from '/assets/logo.png';
<img src={logoImage} alt="Logo" />

// WRONG - Absolute paths break in packaged app
<img src="/assets/logo.png" alt="Logo" />
```

**Why:** In development, Vite serves `/assets/...` from the public folder. But in the packaged Electron app, the renderer loads via `file://` protocol, and absolute paths like `/assets/logo.png` resolve to the filesystem root instead of the app bundle. ES imports are processed by Vite to use `import.meta.url`, which works correctly in both environments.

Static assets go in `apps/desktop/public/assets/`.

## Environment Variables

- `CLEAN_START=1` - Clear all stored data on app start
- `E2E_SKIP_AUTH=1` - Skip onboarding flow (for testing)

## Testing

- E2E tests: `pnpm -F @accomplish/desktop test:e2e`
- Tests use Playwright with serial execution (Electron requirement)
- Test config: `apps/desktop/playwright.config.ts`

## Bundled Node.js

The packaged app bundles standalone Node.js v20.18.1 binaries to ensure MCP servers work on machines without Node.js installed.

### Key Files
- `src/main/utils/bundled-node.ts` - Utility to get bundled node/npm/npx paths
- `scripts/download-nodejs.cjs` - Downloads Node.js binaries for all platforms
- `scripts/after-pack.cjs` - Copies correct binary into app bundle during build

### CRITICAL: Spawning npx/node in Main Process

**IMPORTANT:** When spawning `npx` or `node` in the main process, you MUST add the bundled Node.js bin directory to PATH. This is because `npx` uses a `#!/usr/bin/env node` shebang which looks for `node` in PATH.

```typescript
import { spawn } from 'child_process';
import { getNpxPath, getBundledNodePaths } from '../utils/bundled-node';

// Get bundled paths
const npxPath = getNpxPath();
const bundledPaths = getBundledNodePaths();

// Build environment with bundled node in PATH
let spawnEnv: NodeJS.ProcessEnv = { ...process.env };
if (bundledPaths) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  spawnEnv.PATH = `${bundledPaths.binDir}${delimiter}${process.env.PATH || ''}`;
}

// Spawn with the modified environment
spawn(npxPath, ['-y', 'some-package@latest'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: spawnEnv,
});
```

**Why:** Without adding `bundledPaths.binDir` to PATH, the spawned process will fail with exit code 127 ("node not found") on machines that don't have Node.js installed system-wide.

### For MCP Server Configs

When generating MCP server configurations, pass `NODE_BIN_PATH` in the environment so spawned servers can add it to their PATH:

```typescript
environment: {
  NODE_BIN_PATH: bundledPaths?.binDir || '',
}
```

## Key Behaviors

- Single-instance enforcement - second instance focuses existing window
- API keys stored in OS keychain (macOS Keychain, Windows Credential Vault, Linux Secret Service)
- API key validation via test request to respective provider API
- OpenCode CLI permissions are bridged to UI via IPC `permission:request` / `permission:respond`
- Task output streams through `task:update` and `task:progress` IPC events
