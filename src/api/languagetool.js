/**
 * LanguageTool API routes
 *
 * Mirrors electronAPI.languagetool.*
 */

import { Router } from 'express';

export function createLanguageToolRoutes(ctx) {
  const router = Router();
  const { languageToolService, languageToolPreferencesService } = ctx;

  router.get('/status', async (req, res) => {
    try {
      res.json(await languageToolService.status());
    } catch (err) {
      console.error('[languagetool:status]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/languages', async (req, res) => {
    try {
      res.json(await languageToolService.languages());
    } catch (err) {
      console.error('[languagetool:languages]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/check', async (req, res) => {
    try {
      res.json(await languageToolService.check(req.body || {}));
    } catch (err) {
      console.error('[languagetool:check]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/prefs', async (req, res) => {
    try {
      const { documentPath, projectRoot } = req.query;
      res.json(await languageToolPreferencesService.getForDocument({ documentPath, projectRoot }));
    } catch (err) {
      console.error('[languagetool:getPrefs]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/prefs', async (req, res) => {
    try {
      const { documentPath, patch = {}, projectRoot = null } = req.body || {};
      res.json(await languageToolPreferencesService.setForDocument({ documentPath, patch, projectRoot }));
    } catch (err) {
      console.error('[languagetool:setPrefs]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/prefs/clear', async (req, res) => {
    try {
      const { documentPath, projectRoot = null } = req.body || {};
      res.json(await languageToolPreferencesService.clearDocumentOverrides({ documentPath, projectRoot }));
    } catch (err) {
      console.error('[languagetool:clearPrefs]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/dictionary', (req, res) => {
    try {
      res.json(languageToolPreferencesService.getDictionary());
    } catch (err) {
      console.error('[languagetool:getDictionary]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/dictionary/add', (req, res) => {
    try {
      const { word } = req.body || {};
      res.json(languageToolPreferencesService.addToDictionary(word));
    } catch (err) {
      console.error('[languagetool:addToDictionary]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/dictionary/remove', (req, res) => {
    try {
      const { word } = req.body || {};
      res.json(languageToolPreferencesService.removeFromDictionary(word));
    } catch (err) {
      console.error('[languagetool:removeFromDictionary]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/defaults', (req, res) => {
    try {
      res.json(languageToolPreferencesService.getDefaults());
    } catch (err) {
      console.error('[languagetool:getDefaults]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/defaults', (req, res) => {
    try {
      const { patch = {} } = req.body || {};
      res.json(languageToolPreferencesService.setDefaults(patch));
    } catch (err) {
      console.error('[languagetool:setDefaults]', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
