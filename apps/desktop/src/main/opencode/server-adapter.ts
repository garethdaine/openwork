import { EventEmitter } from 'events';
import { isOpenCodeBundled, getBundledOpenCodeVersion } from './cli-path';
import { getSelectedModel, getOllamaConfig } from '../store/appSettings';
import { ACCOMPLISH_AGENT_NAME } from './config-generator';
import { getSharedServer } from './shared-server';
import type {
  TaskConfig,
  Task,
  TaskMessage,
  TaskResult,
  OpenCodeMessage,
  PermissionRequest,
} from '@accomplish/shared';

/**
 * Error thrown when OpenCode server is not available
 */
export class OpenCodeServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeServerError';
  }
}

/**
 * Check if OpenCode CLI is available (bundled or installed)
 */
export async function isOpenCodeServerAvailable(): Promise<boolean> {
  return isOpenCodeBundled();
}

/**
 * Get OpenCode CLI version
 */
export async function getOpenCodeServerVersion(): Promise<string | null> {
  return getBundledOpenCodeVersion();
}

export interface OpenCodeServerAdapterEvents {
  message: [OpenCodeMessage];
  'text-delta': [{ messageId: string; content: string; isComplete: boolean }];
  'tool-use': [string, unknown];
  'tool-result': [string];
  'permission-request': [PermissionRequest];
  progress: [{ stage: string; message?: string }];
  complete: [TaskResult];
  error: [Error];
  debug: [{ type: string; message: string; data?: unknown }];
}

/**
 * SSE Event parsed from the stream
 */
interface SSEEvent {
  type: string;
  data: unknown;
}

/**
 * OpenCode Server Adapter
 * Uses `opencode serve` HTTP API with SSE for real-time streaming
 */
export class OpenCodeServerAdapter extends EventEmitter<OpenCodeServerAdapterEvents> {
  // Server management is now handled by SharedOpenCodeServer
  // We just keep a reference to the port for API calls
  private serverPort: number | null = null;
  private currentSessionId: string | null = null;
  private currentTaskId: string | null = null;
  private currentMessageId: string | null = null;
  private messages: TaskMessage[] = [];
  private hasCompleted: boolean = false;
  private isDisposed: boolean = false;
  private wasInterrupted: boolean = false;
  private abortController: AbortController | null = null;

  // Streaming state for text deltas
  private streamingMessageId: string | null = null;
  private streamingText: string = '';

  /**
   * Create a new OpenCodeServerAdapter instance
   * @param taskId - Optional task ID for this adapter instance (used for logging)
   */
  constructor(taskId?: string) {
    super();
    this.currentTaskId = taskId || null;
    // Acquire a reference to the shared server
    getSharedServer().acquire();
  }

  /**
   * Start a new task with OpenCode Server
   */
  async startTask(config: TaskConfig): Promise<Task> {
    console.log('[OpenCode Server] startTask called');
    this.emit('debug', { type: 'info', message: 'startTask called' });

    if (this.isDisposed) {
      throw new Error('Adapter has been disposed and cannot start new tasks');
    }

    console.log('[OpenCode Server] Checking CLI availability...');
    this.emit('debug', { type: 'info', message: 'Checking CLI availability...' });

    const cliAvailable = await isOpenCodeServerAvailable();
    if (!cliAvailable) {
      throw new OpenCodeServerError('OpenCode CLI is not available');
    }

    console.log('[OpenCode Server] CLI is available');
    this.emit('debug', { type: 'info', message: 'CLI is available' });

    const taskId = config.taskId || this.generateTaskId();
    this.currentTaskId = taskId;
    this.currentSessionId = null;
    this.currentMessageId = null;
    this.messages = [];
    this.hasCompleted = false;
    this.wasInterrupted = false;
    this.streamingMessageId = null;
    this.streamingText = '';

    // Log the currently selected model
    const selectedModel = getSelectedModel();
    console.log('[OpenCode Server] Selected model from settings:', JSON.stringify(selectedModel));
    this.emit('debug', { type: 'info', message: `Selected model: ${JSON.stringify(selectedModel)}` });

    // Ensure shared server is running (handles config generation and API key sync)
    console.log('[OpenCode Server] Ensuring shared server is running...');
    this.emit('debug', { type: 'info', message: 'Ensuring shared server is running...' });
    const sharedServer = getSharedServer();
    this.serverPort = await sharedServer.ensureRunning(config.workingDirectory);
    console.log('[OpenCode Server] Shared server ready on port:', this.serverPort);
    this.emit('debug', { type: 'info', message: `Shared server ready on port: ${this.serverPort}` });

    // For Ollama, ensure a model variant with num_ctx baked in exists
    // This is the only reliable way to set context window when using OpenAI-compatible endpoint
    let effectiveModelName: string | undefined;
    if (selectedModel?.provider === 'ollama') {
      const ollamaModelName = selectedModel.model.split('/').pop() || selectedModel.model;
      effectiveModelName = await this.ensureOllamaModelWithContext(ollamaModelName, selectedModel.baseUrl);
      console.log('[OpenCode Server] Using Ollama model:', effectiveModelName);
      this.emit('debug', { type: 'info', message: `Using Ollama model: ${effectiveModelName}` });
    }

    // Create or reuse session
    // IMPORTANT: For follow-ups, config.sessionId should be provided to maintain context
    if (config.sessionId) {
      console.log('[OpenCode Server] REUSING existing session:', config.sessionId);
      this.emit('debug', { type: 'info', message: `REUSING existing session: ${config.sessionId}` });
      this.currentSessionId = config.sessionId;

      // Verify the session exists and log its current state
      try {
        const sessionResponse = await fetch(
          `http://localhost:${this.serverPort}/session/${config.sessionId}`,
          { method: 'GET', headers: { 'Accept': 'application/json' } }
        );
        if (sessionResponse.ok) {
          const sessionData = await sessionResponse.json() as Record<string, unknown>;
          console.log('[OpenCode Server] Session verified, keys:', Object.keys(sessionData));
          this.emit('debug', { type: 'info', message: `Session verified: ${JSON.stringify(sessionData).substring(0, 200)}` });

          // Also fetch messages to see what context exists
          const messagesResponse = await fetch(
            `http://localhost:${this.serverPort}/session/${config.sessionId}/message`,
            { method: 'GET', headers: { 'Accept': 'application/json' } }
          );
          if (messagesResponse.ok) {
            const messages = await messagesResponse.json() as unknown[];
            console.log('[OpenCode Server] Session has', messages.length, 'messages in history');
            this.emit('debug', { type: 'info', message: `Session has ${messages.length} messages in history` });
          }
        } else {
          console.warn('[OpenCode Server] Session not found, creating new one');
          this.emit('debug', { type: 'warning', message: 'Session not found on server, creating new one' });
          this.currentSessionId = await this.createSession(effectiveModelName);
        }
      } catch (error) {
        console.warn('[OpenCode Server] Failed to verify session:', error);
        this.emit('debug', { type: 'warning', message: `Failed to verify session: ${(error as Error).message}` });
      }
    } else {
      console.log('[OpenCode Server] Creating NEW session...');
      this.emit('debug', { type: 'info', message: 'Creating NEW session...' });
      this.currentSessionId = await this.createSession(effectiveModelName);
      console.log('[OpenCode Server] NEW session created:', this.currentSessionId);
      this.emit('debug', { type: 'info', message: `NEW session created: ${this.currentSessionId}` });
    }

    // Subscribe to SSE events
    console.log('[OpenCode Server] Subscribing to SSE events...');
    this.emit('debug', { type: 'info', message: 'Subscribing to SSE events...' });
    this.subscribeToEvents();

    // Send the message
    console.log('[OpenCode Server] Sending message...');
    this.emit('debug', { type: 'info', message: 'Sending message...' });
    await this.sendMessage(config.prompt);
    console.log('[OpenCode Server] Message sent');
    this.emit('debug', { type: 'info', message: 'Message sent' });

    this.emit('progress', { stage: 'init', message: 'Task started' });

    return {
      id: taskId,
      prompt: config.prompt,
      status: 'running',
      messages: [],
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Ensure an Ollama model variant exists with the configured num_ctx baked in.
   * This creates a custom model using Ollama's /api/create endpoint with a Modelfile
   * that sets PARAMETER num_ctx to the desired value.
   *
   * This is the only reliable way to set context window for Ollama models when using
   * OpenCode's OpenAI-compatible endpoint, which doesn't support num_ctx in requests.
   *
   * Returns the name of the model to use (either original or the custom variant).
   *
   * See: https://github.com/ollama/ollama/issues/5356
   */
  private async ensureOllamaModelWithContext(modelName: string, baseUrl?: string): Promise<string> {
    const ollamaHost = baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';

    // Determine context window:
    // 1. User override (if set) takes highest priority
    // 2. Model's reported context window
    // 3. Default fallback (32K)
    const ollamaConfig = getOllamaConfig();
    const modelInfo = ollamaConfig?.models?.find(m => m.id === modelName);
    const defaultNumCtx = 32768;
    const numCtx = ollamaConfig?.contextLengthOverride ?? modelInfo?.contextWindow ?? defaultNumCtx;

    // Create a variant name that includes the context size for clarity
    // e.g., "qwen3:8b" -> "qwen3:8b-ctx40k" for 40960 context
    const ctxSuffix = `-ctx${Math.round(numCtx / 1024)}k`;
    const variantName = `${modelName}${ctxSuffix}`;

    console.log('[OpenCode Server] Ensuring Ollama model variant:', variantName);
    console.log('[OpenCode Server] Base model:', modelName, 'num_ctx:', numCtx);
    this.emit('debug', { type: 'info', message: `Ensuring model variant: ${variantName} with num_ctx: ${numCtx}` });

    try {
      // First check if the variant already exists
      const showResponse = await fetch(`${ollamaHost}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: variantName }),
        signal: AbortSignal.timeout(5000),
      });

      if (showResponse.ok) {
        console.log('[OpenCode Server] Model variant already exists:', variantName);
        this.emit('debug', { type: 'info', message: `Model variant exists: ${variantName}` });

        // Preload the variant to ensure it's in memory
        await this.preloadModel(variantName, ollamaHost);
        return variantName;
      }

      // Create the variant using the 'from' and 'parameters' approach
      // This is more reliable than modelfile for simple parameter overrides
      console.log('[OpenCode Server] Creating model variant:', variantName);
      this.emit('debug', { type: 'info', message: `Creating model variant: ${variantName}` });

      const createResponse = await fetch(`${ollamaHost}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: variantName,
          from: modelName,
          parameters: {
            num_ctx: numCtx,
          },
          stream: false,
        }),
        signal: AbortSignal.timeout(30000), // 30s timeout for creation
      });

      if (createResponse.ok) {
        console.log('[OpenCode Server] Model variant created successfully:', variantName);
        this.emit('debug', { type: 'info', message: `Model variant created: ${variantName}` });

        // Preload the new variant
        await this.preloadModel(variantName, ollamaHost);
        return variantName;
      } else {
        const error = await createResponse.text();
        console.warn('[OpenCode Server] Failed to create model variant:', error);
        this.emit('debug', { type: 'warning', message: `Failed to create variant: ${error}` });

        // Fall back to original model with preload
        await this.preloadModel(modelName, ollamaHost, numCtx);
        return modelName;
      }
    } catch (error) {
      console.warn('[OpenCode Server] Error ensuring model variant:', error);
      this.emit('debug', { type: 'warning', message: `Error with model variant: ${(error as Error).message}` });

      // Fall back to original model with preload
      await this.preloadModel(modelName, ollamaHost, numCtx);
      return modelName;
    }
  }

  /**
   * Preload a model to ensure it's in memory
   */
  private async preloadModel(modelName: string, ollamaHost: string, numCtx?: number): Promise<void> {
    console.log('[OpenCode Server] Preloading model:', modelName);
    this.emit('debug', { type: 'info', message: `Preloading model: ${modelName}` });

    try {
      const options: Record<string, unknown> = { num_predict: 1 };
      if (numCtx) {
        options.num_ctx = numCtx;
      }

      const response = await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          keep_alive: '30m',
          options,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (response.ok) {
        console.log('[OpenCode Server] Model preloaded successfully');
        this.emit('debug', { type: 'info', message: 'Model preloaded' });
      }
    } catch (error) {
      console.warn('[OpenCode Server] Model preload failed:', error);
    }
  }

  /**
   * Create a new session
   * @param ollamaModelOverride - For Ollama, use this model name instead of the one from settings
   *                              (used for custom variants with num_ctx baked in)
   */
  private async createSession(ollamaModelOverride?: string): Promise<string> {
    const selectedModel = getSelectedModel();
    console.log('[OpenCode Server] Selected model from settings:', JSON.stringify(selectedModel));
    this.emit('debug', { type: 'info', message: `Selected model: ${JSON.stringify(selectedModel)}` });

    const body: Record<string, unknown> = {};

    // Add model if specified
    if (selectedModel?.model) {
      let modelId = selectedModel.model;
      console.log('[OpenCode Server] Raw model from settings:', modelId);
      console.log('[OpenCode Server] Provider:', selectedModel.provider);

      // Format model ID for the provider
      if (selectedModel.provider === 'ollama') {
        // Use the override if provided (custom variant with num_ctx), otherwise use original
        const ollamaModelName = ollamaModelOverride || selectedModel.model.split('/').pop() || selectedModel.model;
        modelId = `ollama/${ollamaModelName}`;
        console.log('[OpenCode Server] Ollama model ID:', modelId, ollamaModelOverride ? '(custom variant)' : '');
      } else if (selectedModel.provider === 'zai') {
        const id = selectedModel.model.split('/').pop() || selectedModel.model;
        modelId = `zai-coding-plan/${id}`;
      } else if (selectedModel.provider === 'deepseek') {
        const id = selectedModel.model.split('/').pop() || selectedModel.model;
        modelId = `deepseek/${id}`;
      }

      console.log('[OpenCode Server] Final modelId for session:', modelId);
      body.model = modelId;
    } else {
      console.log('[OpenCode Server] WARNING: No model selected!');
    }

    // Add agent
    body.agent = ACCOMPLISH_AGENT_NAME;

    console.log('[OpenCode Server] Creating session with:', body);
    this.emit('debug', { type: 'info', message: `Creating session`, data: body });

    const response = await fetch(`http://localhost:${this.serverPort}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new OpenCodeServerError(`Failed to create session: ${error}`);
    }

    const data = await response.json() as { id: string };
    console.log('[OpenCode Server] Session created:', data.id);
    this.emit('debug', { type: 'info', message: `Session created: ${data.id}` });

    return data.id;
  }

  /**
   * Subscribe to SSE events at /event endpoint
   * Per OpenCode docs: GET /event returns server-sent events stream
   */
  private subscribeToEvents(): void {
    if (!this.serverPort || !this.currentSessionId) {
      console.error('[OpenCode Server] Cannot subscribe: no port or session');
      return;
    }

    this.abortController = new AbortController();

    // Connect to global SSE endpoint /event
    const eventUrl = `http://localhost:${this.serverPort}/event`;
    console.log('[OpenCode Server] Connecting to SSE:', eventUrl);
    this.emit('debug', { type: 'info', message: `Connecting to SSE: ${eventUrl}` });

    this.connectSSE(eventUrl, false);
  }

  /**
   * Poll the session for updates (messages, status changes)
   * We poll GET /session/{id} which returns the full session including messages
   */
  private async pollSessionForUpdates(): Promise<void> {
    const pollInterval = 300; // Poll every 300ms for responsiveness
    let lastMessageCount = 0;
    let lastMessageContent = '';
    let consecutiveIdleCount = 0;
    let debugLogCount = 0;

    while (!this.hasCompleted && !this.isDisposed && !this.abortController?.signal.aborted) {
      try {
        // Fetch full session details (should include messages)
        const sessionResponse = await fetch(
          `http://localhost:${this.serverPort}/session/${this.currentSessionId}`,
          {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
          }
        );

        if (!sessionResponse.ok) {
          console.error('[OpenCode Server] Failed to fetch session:', sessionResponse.status);
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }

        const session = await sessionResponse.json() as Record<string, unknown>;

        // Debug: Log the full session structure on first few polls
        if (debugLogCount < 3) {
          const sessionStr = JSON.stringify(session, null, 2);
          console.log('[OpenCode Server] Full session:', sessionStr.substring(0, 3000));
          this.emit('debug', { type: 'info', message: `Session keys: ${Object.keys(session).join(', ')}` });

          // Check for nested objects that might contain messages
          for (const key of Object.keys(session)) {
            const val = session[key];
            if (val && typeof val === 'object') {
              if (Array.isArray(val)) {
                this.emit('debug', { type: 'info', message: `  ${key}: array[${val.length}]` });
              } else {
                this.emit('debug', { type: 'info', message: `  ${key}: object with keys ${Object.keys(val as object).join(', ')}` });
              }
            }
          }
          debugLogCount++;
        }

        // Try to find messages in various possible locations
        let messages: Array<Record<string, unknown>> = [];
        let status = 'unknown';

        // Check direct properties
        if (Array.isArray(session.messages)) {
          messages = session.messages as Array<Record<string, unknown>>;
        } else if (Array.isArray(session.parts)) {
          messages = session.parts as Array<Record<string, unknown>>;
        } else if (Array.isArray(session.history)) {
          messages = session.history as Array<Record<string, unknown>>;
        }

        // Check for status/busy
        if (typeof session.busy === 'boolean') {
          status = session.busy ? 'busy' : 'idle';
        } else if (typeof session.status === 'string') {
          status = session.status as string;
        } else if (typeof session.state === 'string') {
          status = session.state as string;
        }

        // If no messages found directly, check if there's a nested structure
        if (messages.length === 0 && debugLogCount <= 3) {
          this.emit('debug', { type: 'info', message: `No messages found yet. Status: ${status}` });
        }

        // Check for new messages
        if (messages.length > lastMessageCount) {
          console.log('[OpenCode Server] New messages detected:', messages.length - lastMessageCount);
          this.emit('debug', { type: 'info', message: `New messages: ${messages.length - lastMessageCount}` });

          // Process new messages
          for (let i = lastMessageCount; i < messages.length; i++) {
            const msg = messages[i];
            const role = msg.role as string;
            const parts = msg.parts as Array<Record<string, unknown>> | undefined;
            const msgId = (msg.id || msg.messageId || `msg_${i}`) as string;

            if (role === 'assistant' && parts) {
              for (const part of parts) {
                this.handlePolledPart(msgId, part);
              }
            }
          }
          lastMessageCount = messages.length;
        }

        // Check for updates to the last message (streaming text)
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          const role = lastMsg.role as string;
          const parts = lastMsg.parts as Array<Record<string, unknown>> | undefined;
          const msgId = (lastMsg.id || lastMsg.messageId || 'last') as string;

          if (role === 'assistant' && parts) {
            const textParts = parts.filter(p => p.type === 'text');
            const currentText = textParts.map(p => (p.text || '') as string).join('');

            if (currentText !== lastMessageContent) {
              console.log('[OpenCode Server] Text updated, length:', currentText.length);
              this.emit('debug', { type: 'info', message: `Text updated: ${currentText.length} chars` });

              // Emit text delta
              this.emit('text-delta', {
                messageId: msgId,
                content: currentText,
                isComplete: status === 'idle',
              });

              lastMessageContent = currentText;
            }
          }
        }

        // Check if session is idle (done processing)
        if (status === 'idle') {
          consecutiveIdleCount++;
          if (consecutiveIdleCount >= 2) {
            console.log('[OpenCode Server] Session is idle, completing...');
            this.emit('debug', { type: 'info', message: 'Session idle, completing' });

            // Emit final text as complete
            if (lastMessageContent) {
              const lastMsg = messages[messages.length - 1];
              const msgId = (lastMsg?.id || lastMsg?.messageId || 'final') as string;
              this.emit('text-delta', {
                messageId: msgId,
                content: lastMessageContent,
                isComplete: true,
              });
            }

            this.hasCompleted = true;
            this.emit('complete', {
              status: 'success',
              sessionId: this.currentSessionId || undefined,
            });
            return;
          }
        } else {
          consecutiveIdleCount = 0;
        }

        // Log status periodically
        if (status !== 'idle') {
          this.emit('debug', { type: 'info', message: `Session status: ${status}, messages: ${messages.length}` });
        }

      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          console.log('[OpenCode Server] Polling aborted');
          return;
        }
        console.error('[OpenCode Server] Polling error:', error);
        this.emit('debug', { type: 'error', message: `Polling error: ${(error as Error).message}` });
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  /**
   * Handle a part from polled session data
   */
  private handlePolledPart(messageId: string, part: Record<string, unknown>): void {
    const partType = part.type as string;
    console.log('[OpenCode Server] Processing polled part:', partType);

    switch (partType) {
      case 'text':
        // Text parts are handled by the streaming text detection above
        break;

      case 'tool':
        const toolName = (part.tool || part.name || 'unknown') as string;
        const toolState = part.state as Record<string, unknown> | undefined;

        console.log('[OpenCode Server] Tool:', toolName, 'status:', toolState?.status);
        this.emit('tool-use', toolName, toolState?.input);
        this.emit('progress', { stage: 'tool-use', message: `Using ${toolName}` });

        if (toolState?.status === 'completed' || toolState?.status === 'error') {
          this.emit('tool-result', (toolState?.output || '') as string);
        }
        break;
    }
  }

  /**
   * Connect to SSE endpoint at /event and process events
   * Per OpenCode docs: GET /event returns server-sent events stream
   * First event is `server.connected`, then bus events
   */
  private async connectSSE(url: string, _isRetry: boolean = false): Promise<void> {
    try {
      console.log('[OpenCode Server] Connecting to SSE endpoint:', url);
      this.emit('debug', { type: 'info', message: `Connecting to SSE: ${url}` });

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: this.abortController?.signal,
      });

      console.log('[OpenCode Server] SSE response status:', response.status);
      const contentType = response.headers.get('content-type');
      this.emit('debug', { type: 'info', message: `SSE response: ${response.status}, content-type: ${contentType}` });

      if (!response.ok) {
        throw new OpenCodeServerError(`SSE connection failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new OpenCodeServerError('No response body for SSE');
      }

      console.log('[OpenCode Server] SSE connected, waiting for events...');
      this.emit('debug', { type: 'info', message: 'SSE connected, listening for events...' });

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('[OpenCode Server] SSE stream ended');
          this.emit('debug', { type: 'info', message: 'SSE stream ended' });
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        // Don't log every SSE chunk - too noisy
        buffer += chunk;

        // Process complete SSE events
        const events = this.parseSSEBuffer(buffer);
        buffer = events.remaining;

        for (const event of events.events) {
          this.handleSSEEvent(event);
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('[OpenCode Server] SSE connection aborted');
        return;
      }
      console.error('[OpenCode Server] SSE error:', error);
      this.emit('debug', { type: 'error', message: `SSE error: ${(error as Error).message}` });
      this.emit('error', error as Error);
    }
  }

  /**
   * Parse SSE buffer into events
   */
  private parseSSEBuffer(buffer: string): { events: SSEEvent[]; remaining: string } {
    const events: SSEEvent[] = [];
    const lines = buffer.split('\n');
    let remaining = '';
    let currentEvent: { type?: string; data?: string } = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this is the last incomplete line
      if (i === lines.length - 1 && !buffer.endsWith('\n')) {
        remaining = line;
        break;
      }

      if (line === '') {
        // Empty line signals end of event
        if (currentEvent.data) {
          try {
            const data = JSON.parse(currentEvent.data);
            events.push({
              type: currentEvent.type || data.type || 'message',
              data,
            });
          } catch (e) {
            console.warn('[OpenCode Server] Failed to parse SSE data:', currentEvent.data);
          }
        }
        currentEvent = {};
      } else if (line.startsWith('event:')) {
        currentEvent.type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        // Per SSE spec, multiple data lines should be joined with newlines
        currentEvent.data = currentEvent.data !== undefined ? currentEvent.data + '\n' + data : data;
      }
    }

    return { events, remaining };
  }

  /**
   * Handle an SSE event
   */
  private handleSSEEvent(event: SSEEvent): void {
    const data = event.data as Record<string, unknown>;
    const eventType = event.type || (data.type as string);

    // Only log important events, skip message.part.updated to reduce noise
    if (eventType !== 'message.part.updated') {
      console.log('[OpenCode Server] SSE event:', eventType);
      this.emit('debug', { type: 'sse-event', message: `Event: ${eventType}`, data });
    }

    switch (eventType) {
      case 'session.updated':
      case 'session.created':
        // Session events
        if (data.id) {
          this.currentSessionId = data.id as string;
        }
        break;

      case 'message.updated':
        this.handleMessageUpdated(data);
        break;

      case 'message.part.updated':
        this.handleMessagePartUpdated(data);
        break;

      case 'session.status':
        // Session status update (busy/idle)
        const statusProps = data.properties as Record<string, unknown> || data;
        const statusInfo = statusProps.status as Record<string, unknown> || {};
        const statusType = statusInfo.type as string;

        console.log('[OpenCode Server] Session status:', statusType);
        this.emit('debug', { type: 'info', message: `Session status: ${statusType}` });

        if (statusType === 'idle') {
          console.log('[OpenCode Server] Session is idle, completing...');
          this.finalizeStreaming();
          this.hasCompleted = true;
          this.emit('complete', {
            status: 'success',
            sessionId: this.currentSessionId || undefined,
          });
        }
        break;

      case 'session.idle':
        // Session is idle (no more processing)
        console.log('[OpenCode Server] Session idle');
        this.finalizeStreaming();
        this.hasCompleted = true;
        this.emit('complete', {
          status: 'success',
          sessionId: this.currentSessionId || undefined,
        });
        break;

      case 'session.error':
        // Extract error from properties
        const errorProps = data.properties as Record<string, unknown> || data;
        const errorData = errorProps.error as Record<string, unknown> || {};
        const errorName = errorData.name as string || 'Error';
        const errorDetails = errorData.data as Record<string, unknown> || {};
        const errorMessage = (errorDetails.message || errorData.message || 'Session error') as string;

        console.error('[OpenCode Server] Session error:', errorName, errorMessage);
        this.emit('debug', { type: 'error', message: `${errorName}: ${errorMessage}` });

        this.hasCompleted = true;
        this.emit('complete', {
          status: 'error',
          sessionId: this.currentSessionId || undefined,
          error: `${errorName}: ${errorMessage}`,
        });
        break;

      default:
        console.log('[OpenCode Server] Unhandled event type:', eventType);
    }
  }

  /**
   * Handle message.updated event
   * Event structure: { type, properties: { info: { id, role, ... } } }
   */
  private handleMessageUpdated(data: Record<string, unknown>): void {
    const props = data.properties as Record<string, unknown> || data;
    const info = props.info as Record<string, unknown> || props;

    const messageId = info.id as string;
    const role = info.role as string;

    console.log('[OpenCode Server] Message updated:', messageId, 'role:', role);
    this.emit('debug', { type: 'info', message: `Message: ${messageId}, role: ${role}` });

    if (role === 'assistant') {
      this.currentMessageId = messageId;
    }
  }

  /**
   * Handle message.part.updated event (streaming text deltas)
   * Event structure: { type, properties: { part: { type, text, ... }, messageID, ... } }
   */
  private handleMessagePartUpdated(data: Record<string, unknown>): void {
    const props = data.properties as Record<string, unknown> || data;
    const part = props.part as Record<string, unknown> || props;
    const partType = part.type as string;
    const messageId = (props.messageID || part.messageID || this.currentMessageId) as string;

    // Only log non-streaming part types to reduce noise
    if (partType !== 'text' && partType !== 'text-delta' && partType !== 'reasoning') {
      console.log('[OpenCode Server] Part updated:', partType, 'messageId:', messageId);
      this.emit('debug', { type: 'info', message: `Part: ${partType}` });
    }

    switch (partType) {
      case 'text-start':
        // Start of text streaming
        this.streamingMessageId = messageId;
        this.streamingText = '';
        console.log('[OpenCode Server] Text streaming started for message:', messageId);
        break;

      case 'text-delta':
        // Incremental text chunk
        const deltaText = (part.text || part.delta || '') as string;

        if (this.streamingMessageId !== messageId) {
          this.streamingMessageId = messageId;
          this.streamingText = '';
        }

        this.streamingText += deltaText;

        this.emit('text-delta', {
          messageId,
          content: this.streamingText,
          isComplete: false,
        });

        console.log('[OpenCode Server] Text delta, accumulated length:', this.streamingText.length);
        break;

      case 'text':
        // Text update - contains the current full text content (accumulated)
        // This is NOT a delta - it's the complete text at this point in time
        const fullText = (part.text || '') as string;

        // Track streaming state
        this.streamingMessageId = messageId;
        this.streamingText = fullText;

        // Emit as text-delta (the frontend updateStreamingMessage handles this)
        // NOTE: isComplete is false here - we'll set it to true in finalizeStreaming
        // when the session becomes idle or step-finish is received
        // NOTE: We do NOT emit a 'message' event here because text-delta already
        // creates/updates the message in the frontend store. Emitting both would
        // cause duplicate messages.
        this.emit('text-delta', {
          messageId,
          content: fullText,
          isComplete: false,
        });

        console.log('[OpenCode Server] Text updated, length:', fullText.length);
        break;

      case 'tool':
      case 'tool-call':
        const toolName = (part.tool || part.name || 'unknown') as string;
        const partState = part.state as Record<string, unknown> | undefined;
        const toolInput = part.input || partState?.input;
        const toolOutput = part.output || partState?.output;
        const toolStatus = part.status || partState?.status;

        console.log('[OpenCode Server] Tool:', toolName, 'status:', toolStatus);

        this.emit('tool-use', toolName, toolInput);
        this.emit('progress', { stage: 'tool-use', message: `Using ${toolName}` });

        // Emit as message for backward compatibility
        const toolMessage: OpenCodeMessage = {
          type: 'tool_use',
          timestamp: Date.now(),
          sessionID: this.currentSessionId || undefined,
          part: {
            id: part.id as string || this.generateMessageId(),
            sessionID: this.currentSessionId || '',
            messageID: messageId,
            type: 'tool',
            tool: toolName,
            state: {
              status: toolStatus as 'pending' | 'running' | 'completed' | 'error' || 'running',
              input: toolInput,
              output: toolOutput as string,
            },
          },
        } as OpenCodeMessage;
        this.emit('message', toolMessage);

        if (toolStatus === 'completed' || toolStatus === 'error') {
          this.emit('tool-result', (toolOutput || '') as string);
        }

        // Handle AskUserQuestion
        if (toolName === 'AskUserQuestion') {
          this.handleAskUserQuestion(toolInput as AskUserQuestionInput);
        }
        break;

      case 'step-start':
        this.emit('progress', { stage: 'init', message: 'Processing' });
        break;

      case 'step-finish':
        const reason = part.reason as string;
        if (reason === 'stop' || reason === 'end_turn') {
          this.finalizeStreaming();
        }
        break;

      default:
        console.log('[OpenCode Server] Unhandled part type:', partType);
    }
  }

  /**
   * Finalize any in-progress streaming
   */
  private finalizeStreaming(): void {
    if (this.streamingMessageId && this.streamingText) {
      // Emit final text-delta with isComplete: true
      // The IPC handler's onTextDelta callback will:
      // 1. Forward to renderer for UI update (marking as complete)
      // 2. Save to task history for persistence
      // We don't emit a separate 'message' event to avoid duplicate messages
      this.emit('text-delta', {
        messageId: this.streamingMessageId,
        content: this.streamingText,
        isComplete: true,
      });
    }

    this.streamingMessageId = null;
    this.streamingText = '';
  }

  /**
   * Send a message to the session asynchronously
   * Uses POST /session/:id/prompt_async which returns 204 No Content
   * The response will come via SSE events
   *
   * Per API docs, body can include: { messageID?, model?, agent?, noReply?, system?, tools?, parts }
   */
  private async sendMessage(prompt: string): Promise<void> {
    if (!this.serverPort || !this.currentSessionId) {
      throw new OpenCodeServerError('No active server or session');
    }

    console.log('[OpenCode Server] Sending async message to session:', this.currentSessionId);
    this.emit('debug', { type: 'info', message: `Sending message to ${this.currentSessionId}: ${prompt.substring(0, 100)}...` });

    // Build message body
    // Note: Model is set in the config file and session creation, not in individual messages.
    // Always specify the agent for consistency (CLI does this too with --agent flag)
    const messageBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
      agent: ACCOMPLISH_AGENT_NAME,
    };

    const response = await fetch(
      `http://localhost:${this.serverPort}/session/${this.currentSessionId}/prompt_async`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new OpenCodeServerError(`Failed to send message: ${error}`);
    }

    console.log('[OpenCode Server] Async message sent (204 expected)');
    this.emit('debug', { type: 'info', message: 'Async message sent, waiting for SSE events...' });
  }

  /**
   * Resume an existing session
   */
  async resumeSession(sessionId: string, prompt: string): Promise<Task> {
    return this.startTask({
      prompt,
      sessionId,
    });
  }

  /**
   * Send user response for permission/question
   */
  async sendResponse(response: string): Promise<void> {
    if (!this.serverPort || !this.currentSessionId) {
      throw new Error('No active server or session');
    }

    // Send as a message
    await this.sendMessage(response);
    console.log('[OpenCode Server] Response sent');
  }

  /**
   * Cancel the current task
   * Note: We abort the SSE connection but don't stop the shared server
   */
  async cancelTask(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;

    // Try to abort the session on the server if we have one
    if (this.serverPort && this.currentSessionId) {
      try {
        await fetch(`http://localhost:${this.serverPort}/session/${this.currentSessionId}/abort`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        });
        console.log('[OpenCode Server] Session aborted on server');
      } catch (error) {
        console.warn('[OpenCode Server] Failed to abort session:', error);
      }
    }
  }

  /**
   * Interrupt the current task
   */
  async interruptTask(): Promise<void> {
    this.wasInterrupted = true;
    this.abortController?.abort();

    // Could send an interrupt signal to the server if supported
    console.log('[OpenCode Server] Task interrupted');

    this.emit('complete', {
      status: 'interrupted',
      sessionId: this.currentSessionId || undefined,
    });
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Get the current task ID
   */
  getTaskId(): string | null {
    return this.currentTaskId;
  }

  /**
   * Check if the adapter has been disposed
   */
  isAdapterDisposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Dispose the adapter and clean up all resources
   * Note: We do NOT stop the shared server here - it's kept alive for session continuity
   */
  dispose(): void {
    if (this.isDisposed) return;

    console.log(`[OpenCode Server] Disposing adapter for task ${this.currentTaskId}`);
    this.isDisposed = true;

    // Abort any pending SSE connections
    this.abortController?.abort();
    this.abortController = null;

    // Release our reference to the shared server (but don't stop it)
    getSharedServer().release();

    // Clear adapter state (but keep serverPort as it's shared)
    this.currentSessionId = null;
    this.currentTaskId = null;
    this.currentMessageId = null;
    this.messages = [];
    this.hasCompleted = true;
    this.streamingMessageId = null;
    this.streamingText = '';

    this.removeAllListeners();
    console.log('[OpenCode Server] Adapter disposed (shared server kept alive for session continuity)');
  }

  private handleAskUserQuestion(input: AskUserQuestionInput): void {
    const question = input.questions?.[0];
    if (!question) return;

    const permissionRequest: PermissionRequest = {
      id: this.generateRequestId(),
      taskId: this.currentTaskId || '',
      type: 'question',
      question: question.question,
      options: question.options?.map((o) => ({
        label: o.label,
        description: o.description,
      })),
      multiSelect: question.multiSelect,
      createdAt: new Date().toISOString(),
    };

    this.emit('permission-request', permissionRequest);
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

/**
 * Factory function to create a new server adapter instance
 */
export function createServerAdapter(taskId?: string): OpenCodeServerAdapter {
  return new OpenCodeServerAdapter(taskId);
}
