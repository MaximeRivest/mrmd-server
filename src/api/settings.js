/**
 * Settings API routes
 *
 * Mirrors electronAPI.settings.*
 * Settings are stored at ~/.config/mrmd/settings.json (same as Electron)
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mrmd');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

/**
 * Default settings schema
 */
const DEFAULT_SETTINGS = {
  version: 1,

  // API keys for various providers
  apiKeys: {
    anthropic: '',
    openai: '',
    groq: '',
    gemini: '',
    openrouter: '',
  },

  // Quality level to model mappings (1-5)
  qualityLevels: {
    1: {
      model: 'groq/moonshotai/kimi-k2-instruct-0905',
      reasoningDefault: 0,
      name: 'Quick',
    },
    2: {
      model: 'anthropic/claude-sonnet-4-5',
      reasoningDefault: 1,
      name: 'Balanced',
    },
    3: {
      model: 'gemini/gemini-3-pro-preview',
      reasoningDefault: 2,
      name: 'Deep',
    },
    4: {
      model: 'anthropic/claude-opus-4-5',
      reasoningDefault: 3,
      name: 'Maximum',
    },
    5: {
      type: 'multi',
      models: [
        'openrouter/x-ai/grok-4',
        'openai/gpt-5.2',
        'gemini/gemini-3-pro-preview',
        'anthropic/claude-opus-4-5',
      ],
      synthesizer: 'gemini/gemini-3-pro-preview',
      name: 'Ultimate',
    },
  },

  // Custom AI command sections
  customSections: [],

  // Default preferences
  defaults: {
    juiceLevel: 2,
    reasoningLevel: 1,
  },
};

/**
 * Available API providers with metadata
 */
const API_PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyPrefix: 'sk-ant-',
    envVar: 'ANTHROPIC_API_KEY',
    testEndpoint: 'https://api.anthropic.com/v1/messages',
  },
  openai: {
    name: 'OpenAI',
    keyPrefix: 'sk-',
    envVar: 'OPENAI_API_KEY',
    testEndpoint: 'https://api.openai.com/v1/models',
  },
  groq: {
    name: 'Groq',
    keyPrefix: 'gsk_',
    envVar: 'GROQ_API_KEY',
    testEndpoint: 'https://api.groq.com/openai/v1/models',
  },
  gemini: {
    name: 'Google Gemini',
    keyPrefix: '',
    envVar: 'GEMINI_API_KEY',
    testEndpoint: 'https://generativelanguage.googleapis.com/v1/models',
  },
  openrouter: {
    name: 'OpenRouter',
    keyPrefix: 'sk-or-',
    envVar: 'OPENROUTER_API_KEY',
    testEndpoint: 'https://openrouter.ai/api/v1/models',
  },
};

// In-memory cache
let settingsCache = null;

/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Merge loaded settings with defaults (for schema upgrades)
 */
function mergeWithDefaults(loaded) {
  const merged = { ...DEFAULT_SETTINGS };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (loaded[key] !== undefined) {
      if (typeof DEFAULT_SETTINGS[key] === 'object' && !Array.isArray(DEFAULT_SETTINGS[key])) {
        merged[key] = { ...DEFAULT_SETTINGS[key], ...loaded[key] };
      } else {
        merged[key] = loaded[key];
      }
    }
  }

  if (loaded.version && loaded.version > merged.version) {
    merged.version = loaded.version;
  }

  return merged;
}

/**
 * Load settings from disk
 */
function loadSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  ensureConfigDir();

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const loaded = JSON.parse(content);
      settingsCache = mergeWithDefaults(loaded);
    } else {
      settingsCache = { ...DEFAULT_SETTINGS };
      saveSettings();
    }
  } catch (e) {
    console.error('[settings] Error loading settings:', e.message);
    settingsCache = { ...DEFAULT_SETTINGS };
  }

  return settingsCache;
}

/**
 * Save settings to disk
 */
function saveSettings() {
  ensureConfigDir();
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));
    return true;
  } catch (e) {
    console.error('[settings] Error saving settings:', e.message);
    return false;
  }
}

/**
 * Get a value by dot-notation path
 */
function getByPath(obj, keyPath, defaultValue = undefined) {
  const parts = keyPath.split('.');
  let value = obj;

  for (const part of parts) {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    value = value[part];
  }

  return value !== undefined ? value : defaultValue;
}

/**
 * Set a value by dot-notation path
 */
function setByPath(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Create settings routes
 * @param {import('../server.js').ServerContext} ctx
 */
export function createSettingsRoutes(ctx) {
  const router = Router();

  /**
   * GET /api/settings
   * Get all settings
   */
  router.get('/', (req, res) => {
    try {
      res.json(loadSettings());
    } catch (err) {
      console.error('[settings:getAll]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/settings/key?path=...
   * Get a specific setting by path
   */
  router.get('/key', (req, res) => {
    try {
      const { path: keyPath, default: defaultValue } = req.query;
      if (!keyPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }

      const settings = loadSettings();
      const value = getByPath(settings, keyPath, defaultValue);
      res.json({ value });
    } catch (err) {
      console.error('[settings:get]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/key
   * Set a specific setting by path
   */
  router.post('/key', (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key) {
        return res.status(400).json({ error: 'key required' });
      }

      const settings = loadSettings();
      setByPath(settings, key, value);
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:set]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/update
   * Update multiple settings at once
   */
  router.post('/update', (req, res) => {
    try {
      const { updates } = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'updates object required' });
      }

      const settings = loadSettings();
      for (const [keyPath, value] of Object.entries(updates)) {
        setByPath(settings, keyPath, value);
      }
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:update]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/reset
   * Reset settings to defaults
   */
  router.post('/reset', (req, res) => {
    try {
      settingsCache = { ...DEFAULT_SETTINGS };
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:reset]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // API KEYS
  // ==========================================================================

  /**
   * GET /api/settings/api-keys?masked=true
   * Get all API keys (masked for display by default)
   */
  router.get('/api-keys', (req, res) => {
    try {
      const masked = req.query.masked !== 'false';
      const settings = loadSettings();
      const keys = settings.apiKeys || {};

      if (!masked) {
        return res.json(keys);
      }

      // Mask keys for display
      const maskedKeys = {};
      for (const [provider, key] of Object.entries(keys)) {
        if (key && key.length > 12) {
          maskedKeys[provider] = `${key.slice(0, 8)}${'•'.repeat(key.length - 12)}${key.slice(-4)}`;
        } else if (key) {
          maskedKeys[provider] = '•'.repeat(key.length);
        } else {
          maskedKeys[provider] = '';
        }
      }

      res.json(maskedKeys);
    } catch (err) {
      console.error('[settings:getApiKeys]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/api-key
   * Set an API key for a provider
   */
  router.post('/api-key', (req, res) => {
    try {
      const { provider, key } = req.body;
      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      const settings = loadSettings();
      if (!settings.apiKeys) {
        settings.apiKeys = {};
      }
      settings.apiKeys[provider] = key || '';
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:setApiKey]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/settings/api-key/:provider
   * Get a single API key (unmasked)
   */
  router.get('/api-key/:provider', (req, res) => {
    try {
      const { provider } = req.params;
      const settings = loadSettings();
      const key = settings.apiKeys?.[provider] || '';
      res.json({ key });
    } catch (err) {
      console.error('[settings:getApiKey]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/settings/api-key/:provider/exists
   * Check if a provider has a key configured
   */
  router.get('/api-key/:provider/exists', (req, res) => {
    try {
      const { provider } = req.params;
      const settings = loadSettings();
      const key = settings.apiKeys?.[provider] || '';
      res.json({ hasKey: key.length > 0 });
    } catch (err) {
      console.error('[settings:hasApiKey]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/settings/api-providers
   * Get API provider metadata
   */
  router.get('/api-providers', (req, res) => {
    res.json(API_PROVIDERS);
  });

  // ==========================================================================
  // QUALITY LEVELS
  // ==========================================================================

  /**
   * GET /api/settings/quality-levels
   * Get all quality level configurations
   */
  router.get('/quality-levels', (req, res) => {
    try {
      const settings = loadSettings();
      res.json(settings.qualityLevels || DEFAULT_SETTINGS.qualityLevels);
    } catch (err) {
      console.error('[settings:getQualityLevels]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/quality-level/:level/model
   * Set the model for a quality level
   */
  router.post('/quality-level/:level/model', (req, res) => {
    try {
      const level = parseInt(req.params.level, 10);
      const { model } = req.body;

      if (isNaN(level) || level < 1 || level > 5) {
        return res.status(400).json({ error: 'level must be 1-5' });
      }

      const settings = loadSettings();
      if (!settings.qualityLevels) {
        settings.qualityLevels = { ...DEFAULT_SETTINGS.qualityLevels };
      }

      const current = settings.qualityLevels[level] || {};
      settings.qualityLevels[level] = { ...current, model };

      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:setQualityLevelModel]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // CUSTOM COMMANDS
  // ==========================================================================

  /**
   * GET /api/settings/custom-sections
   * Get all custom sections with their commands
   */
  router.get('/custom-sections', (req, res) => {
    try {
      const settings = loadSettings();
      res.json(settings.customSections || []);
    } catch (err) {
      console.error('[settings:getCustomSections]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/custom-section
   * Add a new custom section
   */
  router.post('/custom-section', (req, res) => {
    try {
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name required' });
      }

      const settings = loadSettings();
      if (!settings.customSections) {
        settings.customSections = [];
      }

      const id = `section-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const section = { id, name, commands: [] };
      settings.customSections.push(section);
      saveSettings();

      res.json(section);
    } catch (err) {
      console.error('[settings:addCustomSection]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/settings/custom-section/:id
   * Remove a custom section
   */
  router.delete('/custom-section/:id', (req, res) => {
    try {
      const { id } = req.params;

      const settings = loadSettings();
      const sections = settings.customSections || [];
      const filtered = sections.filter(s => s.id !== id);

      if (filtered.length === sections.length) {
        return res.status(404).json({ error: 'Section not found' });
      }

      settings.customSections = filtered;
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:removeCustomSection]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/custom-command
   * Add a custom command to a section
   */
  router.post('/custom-command', (req, res) => {
    try {
      const { sectionId, command } = req.body;
      if (!sectionId || !command) {
        return res.status(400).json({ error: 'sectionId and command required' });
      }

      const settings = loadSettings();
      const sections = settings.customSections || [];
      const section = sections.find(s => s.id === sectionId);

      if (!section) {
        return res.status(404).json({ error: 'Section not found' });
      }

      const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newCommand = {
        id,
        ...command,
        program: `Custom_${id.replace(/-/g, '_')}`,
        resultField: command.resultField || 'result',
      };

      section.commands.push(newCommand);
      saveSettings();

      res.json(newCommand);
    } catch (err) {
      console.error('[settings:addCustomCommand]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/settings/custom-command
   * Update a custom command
   */
  router.put('/custom-command', (req, res) => {
    try {
      const { sectionId, commandId, updates } = req.body;
      if (!sectionId || !commandId || !updates) {
        return res.status(400).json({ error: 'sectionId, commandId, and updates required' });
      }

      const settings = loadSettings();
      const sections = settings.customSections || [];
      const section = sections.find(s => s.id === sectionId);

      if (!section) {
        return res.status(404).json({ error: 'Section not found' });
      }

      const command = section.commands.find(c => c.id === commandId);
      if (!command) {
        return res.status(404).json({ error: 'Command not found' });
      }

      Object.assign(command, updates);
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:updateCustomCommand]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/settings/custom-command
   * Remove a custom command
   */
  router.delete('/custom-command', (req, res) => {
    try {
      const { sectionId, commandId } = req.body;
      if (!sectionId || !commandId) {
        return res.status(400).json({ error: 'sectionId and commandId required' });
      }

      const settings = loadSettings();
      const sections = settings.customSections || [];
      const section = sections.find(s => s.id === sectionId);

      if (!section) {
        return res.status(404).json({ error: 'Section not found' });
      }

      const originalLength = section.commands.length;
      section.commands = section.commands.filter(c => c.id !== commandId);

      if (section.commands.length === originalLength) {
        return res.status(404).json({ error: 'Command not found' });
      }

      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:removeCustomCommand]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/settings/custom-commands
   * Get all custom commands as a flat list
   */
  router.get('/custom-commands', (req, res) => {
    try {
      const settings = loadSettings();
      const sections = settings.customSections || [];
      const commands = [];

      for (const section of sections) {
        for (const command of section.commands || []) {
          commands.push({
            ...command,
            sectionId: section.id,
            sectionName: section.name,
          });
        }
      }

      res.json(commands);
    } catch (err) {
      console.error('[settings:getAllCustomCommands]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // DEFAULTS
  // ==========================================================================

  /**
   * GET /api/settings/defaults
   * Get default juice and reasoning levels
   */
  router.get('/defaults', (req, res) => {
    try {
      const settings = loadSettings();
      res.json({
        juiceLevel: settings.defaults?.juiceLevel ?? 2,
        reasoningLevel: settings.defaults?.reasoningLevel ?? 1,
      });
    } catch (err) {
      console.error('[settings:getDefaults]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/defaults
   * Set default juice and/or reasoning levels
   */
  router.post('/defaults', (req, res) => {
    try {
      const { juiceLevel, reasoningLevel } = req.body;

      const settings = loadSettings();
      if (!settings.defaults) {
        settings.defaults = {};
      }

      if (juiceLevel !== undefined) {
        settings.defaults.juiceLevel = juiceLevel;
      }
      if (reasoningLevel !== undefined) {
        settings.defaults.reasoningLevel = reasoningLevel;
      }

      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:setDefaults]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // EXPORT/IMPORT
  // ==========================================================================

  /**
   * GET /api/settings/export?includeKeys=false
   * Export settings to JSON string
   */
  router.get('/export', (req, res) => {
    try {
      const includeKeys = req.query.includeKeys === 'true';
      const settings = loadSettings();

      if (!includeKeys) {
        const exported = { ...settings };
        exported.apiKeys = {};
        return res.json({ json: JSON.stringify(exported, null, 2) });
      }

      res.json({ json: JSON.stringify(settings, null, 2) });
    } catch (err) {
      console.error('[settings:export]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings/import
   * Import settings from JSON string
   */
  router.post('/import', (req, res) => {
    try {
      const { json, mergeKeys } = req.body;
      if (!json) {
        return res.status(400).json({ error: 'json required' });
      }

      const imported = JSON.parse(json);

      if (typeof imported !== 'object') {
        return res.status(400).json({ error: 'Invalid settings format' });
      }

      // Preserve existing keys if not merging
      if (!mergeKeys) {
        const currentSettings = loadSettings();
        imported.apiKeys = currentSettings.apiKeys || {};
      }

      // Merge with defaults and save
      settingsCache = mergeWithDefaults(imported);
      const success = saveSettings();
      res.json({ success });
    } catch (err) {
      console.error('[settings:import]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
