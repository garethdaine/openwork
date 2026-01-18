import Store from 'electron-store';
import type { SelectedModel, OllamaConfig, LiteLLMConfig } from '@accomplish/shared';

/**
 * Recent folder entry
 */
export interface RecentFolder {
  path: string;
  name: string;
  lastUsed: number;
}

/**
 * App settings schema
 */
interface AppSettingsSchema {
  /** Enable debug mode to show backend logs in UI */
  debugMode: boolean;
  /** Whether the user has completed the onboarding wizard */
  onboardingComplete: boolean;
  /** Selected AI model (provider/model format) */
  selectedModel: SelectedModel | null;
  /** Ollama server configuration */
  ollamaConfig: OllamaConfig | null;
  /** LiteLLM proxy configuration */
  litellmConfig: LiteLLMConfig | null;
  /** Enable streaming mode for real-time model responses (uses opencode serve) */
  streamingMode: boolean;
  /** Recent folders used for working directory selection */
  recentFolders: RecentFolder[];
  /** Auto-detect paths in prompts and use as working directory */
  autoPathDetection: boolean;
}

const appSettingsStore = new Store<AppSettingsSchema>({
  name: 'app-settings',
  defaults: {
    debugMode: false,
    onboardingComplete: false,
    selectedModel: {
      provider: 'anthropic',
      model: 'anthropic/claude-opus-4-5',
    },
    ollamaConfig: null,
    litellmConfig: null,
    streamingMode: true, // Default to enabled for real-time streaming
    recentFolders: [],
    autoPathDetection: false,
  },
});

/**
 * Get debug mode setting
 */
export function getDebugMode(): boolean {
  return appSettingsStore.get('debugMode');
}

/**
 * Set debug mode setting
 */
export function setDebugMode(enabled: boolean): void {
  appSettingsStore.set('debugMode', enabled);
}

/**
 * Get onboarding complete setting
 */
export function getOnboardingComplete(): boolean {
  return appSettingsStore.get('onboardingComplete');
}

/**
 * Set onboarding complete setting
 */
export function setOnboardingComplete(complete: boolean): void {
  appSettingsStore.set('onboardingComplete', complete);
}

/**
 * Get selected model
 */
export function getSelectedModel(): SelectedModel | null {
  return appSettingsStore.get('selectedModel');
}

/**
 * Set selected model
 */
export function setSelectedModel(model: SelectedModel): void {
  appSettingsStore.set('selectedModel', model);
}

/**
 * Get Ollama configuration
 */
export function getOllamaConfig(): OllamaConfig | null {
  return appSettingsStore.get('ollamaConfig');
}

/**
 * Set Ollama configuration
 */
export function setOllamaConfig(config: OllamaConfig | null): void {
  appSettingsStore.set('ollamaConfig', config);
}

/**
 * Get LiteLLM configuration
 */
export function getLiteLLMConfig(): LiteLLMConfig | null {
  return appSettingsStore.get('litellmConfig');
}

/**
 * Set LiteLLM configuration
 */
export function setLiteLLMConfig(config: LiteLLMConfig | null): void {
  appSettingsStore.set('litellmConfig', config);
}

/**
 * Get streaming mode setting
 * When enabled, uses opencode serve with SSE for real-time streaming
 * When disabled, uses opencode run --format json (buffered output)
 */
export function getStreamingMode(): boolean {
  return appSettingsStore.get('streamingMode');
}

/**
 * Set streaming mode setting
 */
export function setStreamingMode(enabled: boolean): void {
  appSettingsStore.set('streamingMode', enabled);
}

/**
 * Get recent folders
 */
export function getRecentFolders(): RecentFolder[] {
  return appSettingsStore.get('recentFolders');
}

/**
 * Add or update a recent folder
 */
export function addRecentFolder(path: string, name: string): void {
  const folders = getRecentFolders();
  const existingIndex = folders.findIndex(f => f.path === path);
  
  if (existingIndex >= 0) {
    // Update existing entry
    folders[existingIndex] = { path, name, lastUsed: Date.now() };
  } else {
    // Add new entry
    folders.push({ path, name, lastUsed: Date.now() });
  }
  
  // Sort by last used (most recent first) and limit to 10
  folders.sort((a, b) => b.lastUsed - a.lastUsed);
  const limited = folders.slice(0, 10);
  
  appSettingsStore.set('recentFolders', limited);
}

/**
 * Get auto-path detection setting
 */
export function getAutoPathDetection(): boolean {
  return appSettingsStore.get('autoPathDetection');
}

/**
 * Set auto-path detection setting
 */
export function setAutoPathDetection(enabled: boolean): void {
  appSettingsStore.set('autoPathDetection', enabled);
}

/**
 * Get all app settings
 */
export function getAppSettings(): AppSettingsSchema {
  return {
    debugMode: appSettingsStore.get('debugMode'),
    onboardingComplete: appSettingsStore.get('onboardingComplete'),
    selectedModel: appSettingsStore.get('selectedModel'),
    ollamaConfig: appSettingsStore.get('ollamaConfig') ?? null,
    litellmConfig: appSettingsStore.get('litellmConfig') ?? null,
    streamingMode: appSettingsStore.get('streamingMode'),
    recentFolders: appSettingsStore.get('recentFolders'),
    autoPathDetection: appSettingsStore.get('autoPathDetection'),
  };
}

/**
 * Clear all app settings (reset to defaults)
 * Used during fresh install cleanup
 */
export function clearAppSettings(): void {
  appSettingsStore.clear();
}
