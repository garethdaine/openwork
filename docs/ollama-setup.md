# Ollama Setup Guide

This guide covers how to configure [Ollama](https://ollama.com) with Openwork for running local LLMs.

## Prerequisites

1. Install Ollama from [ollama.com](https://ollama.com)
2. Pull at least one model: `ollama pull qwen3:8b` (or any model you prefer)
3. Ensure Ollama is running: `ollama serve`

## Configuration in Openwork

1. Open **Settings** (gear icon in the sidebar)
2. In the **Ollama** section:
   - Enter the Ollama server URL (default: `http://localhost:11434`)
   - Click **Test Connection** to verify and discover available models
   - Select your preferred model from the dropdown

## Context Window Configuration

### The Challenge

Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) doesn't support setting `num_ctx` (context window size) in API requests. This means that without special handling, models default to a 4096-token context window, even if they support much larger contexts (32K, 40K, 128K+).

### How Openwork Solves This (Automatic)

Openwork automatically creates **custom model variants** with the desired context window baked in. **You don't need to create Modelfiles manually** - Openwork handles this for you:

1. When you start a task, Openwork checks if a variant exists (e.g., `qwen3:8b-ctx40k`)
2. If not, it automatically creates one using Ollama's `/api/create` endpoint
3. The variant has `PARAMETER num_ctx` permanently set
4. All requests use the variant, ensuring consistent context handling

This happens transparently - you just select a model and Openwork ensures it has the right context window.

### Configuration Options

**Automatic (Recommended):**
- Openwork reads each model's maximum context from Ollama's `/api/show` endpoint
- The context window is displayed in the model dropdown (e.g., "Qwen3 8B - 40K ctx")
- No manual configuration needed for most users

**Manual Override:**
- In Settings, use the **Context Length Override** field
- Enter a value in tokens (e.g., `32768` for 32K)
- This overrides the automatic detection for all models
- Useful if you want to limit context to save VRAM

### Example Model Variants

| Base Model | Variant Created | Context |
|------------|-----------------|---------|
| `qwen3:8b` | `qwen3:8b-ctx40k` | 40,960 tokens |
| `llama3.2:3b` | `llama3.2:3b-ctx128k` | 131,072 tokens |
| `deepseek-coder-v2:16b` | `deepseek-coder-v2:16b-ctx32k` | 32,768 tokens |

### Verifying Context Window

Check the debug logs (Settings → Enable Debug Mode) to see:
- `Ensuring model variant: qwen3:8b-ctx40k`
- `Model variant created: qwen3:8b-ctx40k` (first time)
- `Model variant exists: qwen3:8b-ctx40k` (subsequent times)

You can also verify in Ollama directly:
```bash
ollama show qwen3:8b-ctx40k --modelfile
```

This should show `PARAMETER num_ctx 40960` (or your configured value).

## Remote Ollama Servers

To use Ollama running on another machine:

1. On the remote machine, start Ollama with network access:
   ```bash
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

2. In Openwork Settings, enter the remote URL:
   ```
   http://<server-ip>:11434
   ```

3. Click **Test Connection** to verify

**Security Note:** Ollama doesn't have built-in authentication. Only expose it on trusted networks or use a reverse proxy with authentication.

## Tool Calling Support

Openwork uses MCP (Model Context Protocol) tools for file permissions, user questions, and browser automation. Tool calling support varies significantly between Ollama models.

### Tool Calling Requirements

For tools to work properly, the model must:
1. Support function/tool calling in Ollama
2. Have the correct chat template with tool schema
3. Be running on Ollama 0.8.0+ (for streaming tool calls)

### Known Tool Calling Behavior

| Model Family | Tool Support | Notes |
|--------------|--------------|-------|
| **Qwen3** | ✅ Good | Officially supported, recommended for tool use |
| **Qwen2.5 (small, e.g. 7b)** | ⚠️ Partial | More reliable than larger variants |
| **Qwen2.5 (large, e.g. 32b)** | ❌ Unreliable | Often says it will use tools but doesn't |
| **Llama 3.2** | ✅ Good | Good tool support |
| **DeepSeek Coder** | ❌ Limited | Coding-focused, minimal tool support |
| **CodeStral** | ❌ Limited | Coding-focused, minimal tool support |

### Common Tool Calling Issues

**Model says it will use a tool but doesn't:**
- This is a known issue with some models (especially Qwen2.5 32b)
- The model generates text describing what it would do, but never actually calls the tool
- **Solution:** Switch to a model with better tool support (e.g., Qwen3:8b)

**"Does not support tools" error:**
- Some model variants lack the required chat template
- **Solution:** Use the official Ollama model, not custom quantized versions

**Tools work sometimes but not consistently:**
- Long conversations can cause models to "forget" about tools
- **Solution:** Start a new conversation or use a model with more reliable tool support

### Recommended Models for Tool Use

If you need tool calling (file operations, browser automation, user interactions):

1. **Qwen3:8b** - Best balance of capability and reliability
2. **Llama 3.2:3b** - Fast, reliable tool support, lower resource usage
3. **Qwen3:14b** - More capable, still good tool support

If you only need text generation/coding without tools:
- DeepSeek Coder, CodeStral, and Qwen2.5 Coder work well

## Recommended Models

| Model | Size | Context | Tool Support | Best For |
|-------|------|---------|--------------|----------|
| `qwen3:8b` | 8B | 40K | ✅ Good | General coding with tools |
| `qwen3:14b` | 14B | 40K | ✅ Good | Better reasoning with tools |
| `llama3.2:3b` | 3B | 128K | ✅ Good | Fast, lower resource usage |
| `qwen2.5:7b` | 7B | 128K | ⚠️ Partial | Text generation, limited tools |
| `deepseek-coder-v2:16b` | 16B | 128K | ❌ Limited | Long context coding (no tools) |
| `codestral:22b` | 22B | 32K | ❌ Limited | Advanced code generation (no tools) |

## Troubleshooting

### "Connection refused" error
- Ensure Ollama is running: `ollama serve`
- Check the URL matches Ollama's host/port

### "Model not found" error
- Pull the model first: `ollama pull <model-name>`
- Verify with: `ollama list`

### Context seems limited despite settings
- Check debug logs for variant creation messages
- Verify the variant exists: `ollama show <model>-ctx<size>k --modelfile`
- Try deleting the variant and letting Openwork recreate it:
  ```bash
  ollama rm qwen3:8b-ctx40k
  ```

### High memory usage
- Larger context windows require more VRAM
- Use the Context Length Override to reduce context if needed
- Consider a smaller model for limited hardware

## Technical Details

### Files Involved

| File | Purpose |
|------|---------|
| `main/ipc/handlers.ts` | `ollama:test-connection` - discovers models and their context windows |
| `main/opencode/config-generator.ts` | Generates OpenCode config with model variants |
| `main/opencode/server-adapter.ts` | `ensureOllamaModelWithContext()` - creates variants via `/api/create` |
| `main/opencode/shared-server.ts` | Sets `OLLAMA_CONTEXT_LENGTH` environment variable |

### API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tags` | List available models |
| `POST /api/show` | Get model details including context_length |
| `POST /api/create` | Create model variant with Modelfile |
| `POST /api/chat` | Preload model into memory |

### Modelfile Syntax

The app generates Modelfiles like:
```
FROM qwen3:8b
PARAMETER num_ctx 40960
```

This creates a lightweight "link" to the base model with the parameter override.
