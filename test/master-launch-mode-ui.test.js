'use strict';

/*
 * #2197 — the Master settings modal must not carry one engine's launch mode
 * onto another, and must say when a save reset one.
 *
 * The server ties the Master's launch mode to the engine it was chosen for
 * (`test/master-launch-mode.test.js`, `test/api-config.test.js`). That alone
 * left the modal wrong in three ways: it sent the launch mode on every save,
 * read from a control drawn for the engine stored before the operator moved the
 * engine dropdown, so the server was told the old mode had been chosen for the
 * new engine; it showed the old engine's selection whenever the new engine
 * defined a mode under the same key; and it never read the save's `warnings`.
 *
 * These run the modal's own functions: the two pure helpers over every bundled
 * engine profile, then the real component against a form that parses what it
 * renders, then the modal's save bodies through the server's rule.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');
// Every bundled profile, read from the directory, so an engine added later is
// compared without anyone remembering to list it here.
const ENGINE_IDS = fs.readdirSync(ENGINES_DIR)
  .filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();

/**
 * A bundled engine profile, as shipped.
 * @param {string} id - Engine id
 * @returns {object}
 */
function profile(id) {
  return JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, `${id}.json`), 'utf8'));
}

// The picker roster as a page holds it: id, name and the profile's modes.
const ROSTER = ENGINE_IDS.map((id) => {
  const p = profile(id);
  return { id: p.id, name: p.name, available: true, launchModes: p.launchModes };
});

/**
 * The modes an engine offers, in the shape the status payload lists them.
 * @param {string} id - Engine id
 * @returns {Array<{id: string, label: string, warning: (string|null)}>}
 */
function offeredBy(id) {
  return Object.entries(profile(id).launchModes)
    .filter(([, m]) => m && m.disabled !== true)
    .map(([key, m]) => ({ id: key, label: m.label || key, warning: m.warning || null }));
}

/**
 * `status.settings` for a Master pinned to one engine that is the one running.
 * @param {string} engine - The pinned engine
 * @param {string} mode - The stored launch mode
 * @param {object} [over] - Fields to replace
 * @returns {object}
 */
function settingsOn(engine, mode, over = {}) {
  return {
    accessLevel: 'read-only',
    accessLevels: ['read-only', 'suggest', 'write'],
    enabledAccessLevels: ['read-only', 'suggest', 'write'],
    levelAppliesAt: 'next-tool-call',
    engine,
    resolvedEngine: engine,
    launchMode: mode,
    launchModeEngine: mode === 'default' ? null : engine,
    resolvedLaunchMode: mode,
    launchModes: offeredBy(engine),
    scope: 'all',
    autoStart: false,
    enforcement: 'structural',
    ...over
  };
}

/**
 * Load api-helper.js in a context and return its exported globals.
 * @returns {object} The sandbox.
 */
function loadHelper() {
  // The status line hides itself on a timer; nothing here waits for it.
  const sandbox = { console, setTimeout: () => 0 };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return sandbox;
}

/**
 * Read one `<select>` out of rendered markup, as a control a handler can use.
 * @param {string} html - Rendered markup
 * @param {string} id - The select's id
 * @returns {object|null} `{value, dataset, options, getAttribute}`, or null when absent.
 */
function selectIn(html, id) {
  const found = new RegExp(`<select id="${id}"([^>]*)>([\\s\\S]*?)</select>`).exec(html);
  if (!found) return null;
  const options = [...found[2].matchAll(/<option value="([^"]*)"\s*(selected)?\s*>([^<]*)<\/option>/g)]
    .map((m) => ({ value: m[1], selected: Boolean(m[2]), text: m[3] }));
  const chosen = options.find((o) => o.selected) || options[0];
  const action = /data-action="([^"]*)"/.exec(found[1]);
  const control = {
    value: chosen ? chosen.value : '',
    options,
    dataset: /data-send="1"/.test(found[1]) ? { send: '1' } : {},
    getAttribute: (name) => (name === 'data-action' && action ? action[1] : null)
  };
  control.closest = () => control;
  return control;
}

/**
 * The real settings component over a form that holds what it renders.
 *
 * @param {object} settings - `status.settings` the modal opens on.
 * @param {object} [options]
 * @param {object|null} [options.config] - The page's `state.config`.
 * @param {object[]} [options.engines] - The page's roster.
 * @param {Function} [options.patch] - `(body) => response` for `PATCH /api/config`.
 * @param {string} [options.lastError] - What `api.lastError` holds after a failed save.
 * @returns {object} The form: `open`, `moveEngine`, `pickMode`, `save`, and readers.
 */
function openForm(settings, options = {}) {
  const sent = [];
  const listeners = { click: [], change: [] };
  const live = { status: settings, statusReads: 0, statusFails: false };
  const els = {};
  let bodyHtml = '';
  let groupHtml = null;
  els.masterSettingsBody = {
    get innerHTML() { return bodyHtml; },
    set innerHTML(v) {
      bodyHtml = v;
      groupHtml = null;
      els.masterEngineSelect = selectIn(v, 'masterEngineSelect');
      els.masterLaunchModeSelect = selectIn(v, 'masterLaunchModeSelect');
    },
    addEventListener: (type, fn) => listeners[type].push(fn)
  };
  els.masterLaunchModeGroup = {
    get innerHTML() {
      if (groupHtml !== null) return groupHtml;
      const start = bodyHtml.indexOf('id="masterLaunchModeGroup"');
      return bodyHtml.slice(start, bodyHtml.indexOf('for="masterScopeSelect"', start));
    },
    set innerHTML(v) {
      groupHtml = v;
      els.masterLaunchModeSelect = selectIn(v, 'masterLaunchModeSelect');
    }
  };
  const classes = new Set();
  const inert = { addEventListener() {} };
  els.masterSettingsModal = {
    dataset: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    addEventListener() {}
  };
  els.masterSettingsCloseBtn = inert;
  els.masterSettingsSaveBtn = inert;
  els.masterScopeSelect = { value: '' };
  els.masterAutoStart = { checked: false };
  els.masterRulesList = { innerHTML: '' };
  els.masterRulesStatus = { textContent: '', className: '', classList: { add() {}, remove() {} } };

  const api = async (url) => {
    if (url === '/api/master/status') {
      live.statusReads += 1;
      return live.statusFails ? null : { settings: live.status };
    }
    if (url === '/api/groups') return { groups: [] };
    return { rules: [] };
  };
  api.lastError = options.lastError || null;

  const component = loadHelper().tcCreateMasterSettings({
    api,
    apiMutate: async (_url, _method, body) => {
      sent.push(body.master);
      return options.patch ? options.patch(body, live) : { ok: true, warnings: [] };
    },
    esc: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    buildEngineOptions: (list, selected) => list
      .map((e) => `<option value="${e.id}" ${e.id === selected ? 'selected' : ''}>${e.name}</option>`).join(''),
    state: { engines: options.engines || ROSTER, config: options.config === undefined ? { defaultEngine: 'claude' } : options.config },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => ({ value: settings.accessLevel })
    }
  });
  component.mount();

  /** @param {object} control - The control a `change` event came from. */
  const changed = (control) => listeners.change.forEach((fn) => fn({ type: 'change', target: control }));
  return {
    live,
    open: () => component.open(),
    /** @param {string} value - The engine dropdown's new value. */
    moveEngine(value) {
      els.masterEngineSelect.value = value;
      changed(els.masterEngineSelect);
    },
    /** @param {string} value - The launch-mode control's new value. */
    pickMode(value) {
      assert.ok(els.masterLaunchModeSelect.options.some((o) => o.value === value),
        `${value} must be an option of the control before it can be picked`);
      els.masterLaunchModeSelect.value = value;
      changed(els.masterLaunchModeSelect);
    },
    /** @returns {Promise<object>} The `master` patch the save sent. */
    async save() {
      await component.save();
      return sent[sent.length - 1];
    },
    mode: () => els.masterLaunchModeSelect,
    group: () => els.masterLaunchModeGroup.innerHTML,
    statusLine: () => els.masterRulesStatus
  };
}

describe('#2197 — the Master settings modal and an engine change', () => {
  let helpers;
  before(() => { helpers = loadHelper(); });

  /**
   * The view for a stored engine and mode once the dropdown names `pin`.
   * @param {object} settings - `status.settings`
   * @param {string} pin - The dropdown's value
   * @param {string|null} [defaultEngine] - The page's `config.defaultEngine`
   * @returns {object}
   */
  const view = (settings, pin, defaultEngine = 'claude') =>
    helpers.tcMasterLaunchModeView(settings, ROSTER, pin, defaultEngine);
  /**
   * The ids of a list of modes. `Array.from` because a list the helper built
   * belongs to the sandbox's realm, and `deepEqual` compares prototypes.
   * @param {object[]} modes - `{id}` entries.
   * @returns {string[]}
   */
  const ids = (modes) => Array.from(modes, (m) => m.id);

  describe('tcMasterEngineModes — an engine\'s modes from the roster', () => {
    it('lists each bundled engine\'s honored modes with their labels and warnings', () => {
      for (const id of ENGINE_IDS) {
        assert.deepEqual(JSON.parse(JSON.stringify(helpers.tcMasterEngineModes(ROSTER, id))), offeredBy(id), id);
      }
    });

    it('leaves out a disabled mode and falls back to the key for a missing label', () => {
      const roster = [{ id: 'x', launchModes: { default: {}, off: { label: 'Off', disabled: true }, warned: { label: 'W', warning: 'careful' } } }];
      assert.deepEqual(JSON.parse(JSON.stringify(helpers.tcMasterEngineModes(roster, 'x'))), [
        { id: 'default', label: 'default', warning: null },
        { id: 'warned', label: 'W', warning: 'careful' }
      ]);
    });

    it('answers an empty list for an engine the roster does not hold, or no roster', () => {
      assert.equal(helpers.tcMasterEngineModes(ROSTER, 'nonesuch').length, 0);
      assert.equal(helpers.tcMasterEngineModes(ROSTER, null).length, 0);
      assert.equal(helpers.tcMasterEngineModes(null, 'claude').length, 0);
    });
  });

  describe('tcMasterLaunchModeView — what the control shows, and whether a save sends it', () => {
    it('shows the stored mode on the stored engine and does not send it untouched', () => {
      for (const engine of ENGINE_IDS) {
        for (const mode of ids(offeredBy(engine))) {
          const v = view(settingsOn(engine, mode), engine);
          assert.equal(v.moved, false, `${engine}/${mode}`);
          assert.equal(v.selected, mode, `${engine}/${mode}`);
          assert.equal(v.send, false, `${engine}/${mode} must not be resent by a save about something else`);
          assert.equal(v.foreign, null);
          assert.deepEqual(ids(v.modes), ids(offeredBy(engine)));
        }
      }
    });

    it('shows default and the other engine\'s modes for any other engine, whatever is stored', () => {
      for (const from of ENGINE_IDS) {
        for (const mode of ids(offeredBy(from))) {
          for (const to of ENGINE_IDS.filter((id) => id !== from)) {
            const v = view(settingsOn(from, mode), to);
            assert.equal(v.moved, true, `${from}/${mode} to ${to}`);
            assert.equal(v.engineId, to);
            assert.equal(v.selected, 'default', `${from}/${mode} shown on ${to}`);
            assert.deepEqual(ids(v.modes), ids(offeredBy(to)), `${to}'s own list`);
            assert.equal(v.send, true, 'a mode drawn for a new engine is a choice for it and is always sent');
            assert.equal(v.stranded, false);
          }
        }
      }
    });

    it('names the mode that does not carry, and the engine it was chosen for', () => {
      assert.deepEqual(JSON.parse(JSON.stringify(view(settingsOn('claude', 'bypassPermissions'), 'codex').foreign)),
        { mode: 'bypassPermissions', engine: 'claude' });
      assert.equal(view(settingsOn('claude', 'default'), 'codex').foreign, null, 'default belongs to no engine');
    });

    it('reads the empty pin as the default engine', () => {
      const follows = settingsOn('claude', 'plan', { engine: null });
      assert.equal(view(follows, '', 'claude').moved, false);
      assert.equal(view(follows, '', 'claude').selected, 'plan');
      // Pinning the engine the Master already follows changes no engine, and
      // the server reads it the same way.
      const pinned = view(follows, 'claude', 'claude');
      assert.equal(pinned.moved, false);
      assert.equal(pinned.selected, 'plan');
      assert.equal(pinned.send, false);
      assert.equal(view(follows, 'codex', 'claude').moved, true);
      // And the other way: removing a pin that restated the default engine.
      const unpinned = view(settingsOn('claude', 'plan'), '', 'claude');
      assert.equal(unpinned.moved, false);
      assert.equal(unpinned.selected, 'plan');
      const toDefault = view(settingsOn('claude', 'plan'), '', 'codex');
      assert.equal(toDefault.moved, true);
      assert.equal(toDefault.engineId, 'codex');
      assert.equal(toDefault.selected, 'default');
    });

    it('lists nothing, rather than guess, when the page does not know the default engine', () => {
      const v = view(settingsOn('claude', 'plan'), '', null);
      assert.equal(v.moved, true);
      assert.equal(v.engineId, null);
      assert.equal(v.modes.length, 0, 'no list means no control, so the save sends no mode and the server decides');
      assert.equal(v.selected, 'default');
    });

    it('falls back to the resolved engine as the stored one when there is no pin and no known default', () => {
      const follows = settingsOn('claude', 'plan', { engine: null });
      assert.equal(view(follows, '', null).moved, false);
      assert.equal(view(follows, 'claude', null).moved, false);
      assert.equal(view(follows, 'codex', null).moved, true);
    });

    it('shows a mode already recorded for the engine being switched to', () => {
      // Stored for Codex while the Master is set to Claude Code: an engine
      // change no save saw. It is not Claude Code's, and it is Codex's.
      const s = settingsOn('claude', 'bypassPermissions', { launchModeEngine: 'codex', resolvedLaunchMode: 'default' });
      const here = view(s, 'claude');
      assert.equal(here.selected, 'default', 'not shown as chosen for the engine set now');
      assert.deepEqual(JSON.parse(JSON.stringify(here.foreign)), { mode: 'bypassPermissions', engine: 'codex' });
      assert.equal(here.send, true, 'the selection is sent, so saving Interactive clears it as the server asks');
      const there = view(s, 'codex');
      assert.equal(there.selected, 'bypassPermissions');
      assert.equal(there.foreign, null);
      assert.equal(there.send, true);
    });

    it('lists the modes of the engine that is set while another stands in for it', () => {
      const s = settingsOn('claude', 'acceptEdits', {
        resolvedEngine: 'codex', resolvedLaunchMode: 'default', launchModes: offeredBy('codex')
      });
      const v = view(s, 'claude');
      assert.equal(v.standIn, true);
      assert.equal(v.moved, false);
      assert.deepEqual(ids(v.modes), ids(offeredBy('claude')), 'a mode is chosen for the engine set, never the stand-in');
      assert.equal(v.selected, 'acceptEdits');
      assert.equal(v.send, false);
      // The same reading when the Master follows a default engine that is missing.
      const following = view({ ...s, engine: null }, '', 'claude');
      assert.equal(following.standIn, true);
      assert.deepEqual(ids(following.modes), ids(offeredBy('claude')));
    });

    it('keeps a stored mode the stored engine no longer offers, and says it is stranded', () => {
      const s = settingsOn('aider', 'acceptEdits', { resolvedLaunchMode: 'default' });
      const v = view(s, 'aider');
      assert.equal(v.stranded, true);
      assert.equal(v.selected, 'acceptEdits');
      assert.equal(v.send, false);
    });

    it('reads a payload with no recorded engine as chosen for the stored engine', () => {
      const s = settingsOn('claude', 'plan');
      delete s.launchModeEngine;
      assert.equal(view(s, 'claude').selected, 'plan');
      assert.equal(view(s, 'claude').foreign, null);
      assert.equal(view(s, 'codex').selected, 'default');
    });

    it('answers default for no settings at all', () => {
      const v = helpers.tcMasterLaunchModeView(null, ROSTER, '', null);
      assert.equal(v.selected, 'default');
      assert.equal(v.modes.length, 0);
      assert.equal(v.moved, false);
    });
  });

  describe('the modal', () => {
    it('shows the new engine\'s modes and default when the engine dropdown moves, and the stored mode when it moves back', async () => {
      const form = openForm(settingsOn('claude', 'acceptEdits'));
      await form.open();
      assert.equal(form.mode().value, 'acceptEdits');

      form.moveEngine('codex');
      assert.deepEqual(form.mode().options.map((o) => o.value), ids(offeredBy('codex')));
      assert.equal(form.mode().value, 'default');
      assert.match(form.group(), /launch modes of Codex/);
      assert.match(form.group(), /<code>acceptEdits<\/code> was chosen for Claude Code and does not carry/);

      form.moveEngine('claude');
      assert.deepEqual(form.mode().options.map((o) => o.value), ids(offeredBy('claude')));
      assert.equal(form.mode().value, 'acceptEdits');
      assert.doesNotMatch(form.group(), /does not carry/);
    });

    it('does not select a mode the two engines share a key for', async () => {
      // The defect as reported: Bypass stored for Claude Code, and Codex
      // defines `bypassPermissions` too, meaning something wider by it.
      const form = openForm(settingsOn('claude', 'bypassPermissions'));
      await form.open();
      form.moveEngine('codex');
      assert.ok(form.mode().options.some((o) => o.value === 'bypassPermissions'), 'Codex offers the key');
      assert.equal(form.mode().value, 'default', 'and it is not selected for Codex');
    });

    it('no longer promises that the choice comes back on switching back', async () => {
      const form = openForm(settingsOn('aider', 'acceptEdits', { resolvedLaunchMode: 'default' }));
      await form.open();
      assert.match(form.group(), /cannot honor/);
      assert.doesNotMatch(form.group(), /applies again if you switch back/);
      assert.doesNotMatch(HELPER_SRC, /applies again if you switch back/);
    });

    it('says which engine the modes belong to while another stands in', async () => {
      const form = openForm(settingsOn('claude', 'acceptEdits', {
        resolvedEngine: 'codex', resolvedLaunchMode: 'default', launchModes: offeredBy('codex')
      }));
      await form.open();
      assert.match(form.group(), /Claude Code is the engine set for the master, and Codex is standing in for it/);
      assert.match(form.group(), /the stand-in will start in <code>default<\/code>/);
      assert.deepEqual(form.mode().options.map((o) => o.value), ids(offeredBy('claude')));
      assert.equal(form.mode().value, 'acceptEdits');
    });

    it('says a stored mode belongs to another engine instead of showing it as chosen here', async () => {
      const form = openForm(settingsOn('codex', 'bypassPermissions', { launchModeEngine: 'claude', resolvedLaunchMode: 'default' }));
      await form.open();
      assert.equal(form.mode().value, 'default');
      assert.match(form.group(), /Saved as <code>bypassPermissions<\/code> for Claude Code, which is not used on Codex/);
      assert.match(form.group(), /the master will start in <code>default<\/code>/);
    });

    it('says there is nothing to choose from when the moved-to engine lists no modes, each case in its own words', async () => {
      const form = openForm(settingsOn('claude', 'plan'), { config: null });
      await form.open();
      form.moveEngine('');
      assert.equal(form.mode(), null);
      assert.match(form.group(), /does not know which engine is the default/);

      const bare = openForm(settingsOn('claude', 'plan'), { engines: [{ id: 'claude', name: 'Claude Code' }, { id: 'bare', name: 'Bare' }] });
      await bare.open();
      bare.moveEngine('bare');
      assert.equal(bare.mode(), null);
      assert.match(bare.group(), /lists no launch modes for Bare/);
    });

    it('announces what it redraws: the group is a polite live region', async () => {
      const form = openForm(settingsOn('claude', 'plan'));
      await form.open();
      assert.match(form.group(), /^id="masterLaunchModeGroup" aria-live="polite">/);
    });

    it('escapes an engine name and a mode key it renders', async () => {
      const form = openForm(settingsOn('claude', '<b>mode</b>', { launchModeEngine: 'other' }), {
        engines: [{ id: 'claude', name: 'Claude <i>Code</i>', launchModes: profile('claude').launchModes },
          { id: 'other', name: '<script>x</script>' }]
      });
      await form.open();
      assert.doesNotMatch(form.group(), /<script>|<b>mode|<i>Code/);
      assert.match(form.group(), /&lt;script&gt;/);
    });
  });

  describe('what a save sends', () => {
    it('sends no launch mode when neither the engine nor the mode was touched', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'));
      await form.open();
      const patch = await form.save();
      assert.ok(!('launchMode' in patch), 'an untouched mode is not a choice');
      assert.equal(patch.engine, 'claude', 'the rest of the form still saves');
    });

    it('sends a mode the operator picked on an unchanged engine', async () => {
      const form = openForm(settingsOn('claude', 'default'));
      await form.open();
      form.pickMode('plan');
      assert.equal((await form.save()).launchMode, 'plan');
    });

    it('sends default with an engine change the operator left the mode alone on', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'));
      await form.open();
      form.moveEngine('codex');
      const patch = await form.save();
      assert.equal(patch.engine, 'codex');
      assert.equal(patch.launchMode, 'default', 'never the old engine\'s mode');
    });

    it('sends the mode picked for the new engine, even when its key equals the stored one', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'));
      await form.open();
      form.moveEngine('codex');
      form.pickMode('bypassPermissions');
      const patch = await form.save();
      assert.equal(patch.engine, 'codex');
      assert.equal(patch.launchMode, 'bypassPermissions');
    });

    it('sends no launch mode when the engine was moved and moved back', async () => {
      const form = openForm(settingsOn('claude', 'acceptEdits'));
      await form.open();
      form.moveEngine('codex');
      form.moveEngine('claude');
      const patch = await form.save();
      assert.ok(!('launchMode' in patch));
      assert.equal(patch.engine, 'claude');
    });

    it('sends no launch mode when there is no control to read', async () => {
      const form = openForm(settingsOn('claude', 'plan'), { config: null });
      await form.open();
      form.moveEngine('');
      const patch = await form.save();
      assert.ok(!('launchMode' in patch));
      assert.equal(patch.engine, null);
    });

    it('sends the selection beside a stored mode that belongs to another engine', async () => {
      // The server's notice for this case asks for Interactive to be saved
      // first. The control already shows Interactive, so it must be sent
      // without the operator having to change it away and back.
      const form = openForm(settingsOn('codex', 'bypassPermissions', { launchModeEngine: 'claude', resolvedLaunchMode: 'default' }));
      await form.open();
      assert.equal((await form.save()).launchMode, 'default');
    });
  });

  describe('what a save shows', () => {
    const RESET = 'The Master\'s launch mode is reset to Interactive. Bypass was chosen for Claude Code and does not carry to Codex. Choose a launch mode for Codex if you want one.';

    /**
     * A `PATCH /api/config` that applies the engine change and answers a reset.
     * @param {object} body - The request body
     * @param {object} live - The form's server state
     * @returns {object}
     */
    function resetting(body, live) {
      live.status = settingsOn(body.master.engine, 'default');
      return { ok: true, warnings: [RESET] };
    }

    it('shows a returned warning under Launch mode, where it stays, and points at it from the status line', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'), { patch: resetting });
      await form.open();
      form.moveEngine('codex');
      await form.save();
      assert.match(form.group(), /<div class="form-hint"><strong>The Master's launch mode is reset to Interactive\./);
      assert.match(form.group(), /does not carry to Codex/);
      assert.match(form.statusLine().textContent, /Settings saved, with a notice under Launch mode/);
      assert.match(form.statusLine().textContent, /launch mode and scope apply on next master start/);
      assert.match(form.statusLine().className, /rules-status-ok/);
    });

    it('says only that the settings were saved when the save answered no warning', async () => {
      const form = openForm(settingsOn('claude', 'default'));
      await form.open();
      await form.save();
      assert.equal(form.statusLine().textContent, 'Settings saved — engine, launch mode and scope apply on next master start');
      assert.doesNotMatch(form.group(), /<div class="form-hint"><strong>/, 'no notice is drawn');
    });

    it('reads the stored settings back, so moving the engine back does not show the mode the save reset', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'), { patch: resetting });
      await form.open();
      form.moveEngine('codex');
      await form.save();
      assert.equal(form.live.statusReads, 2, 'one read to open, one after the save');
      assert.equal(form.mode().value, 'default');
      assert.deepEqual(form.mode().options.map((o) => o.value), ids(offeredBy('codex')));

      form.moveEngine('claude');
      assert.equal(form.mode().value, 'default', 'Bypass was reset: it is no longer stored for Claude Code');
      const patch = await form.save();
      assert.equal(patch.engine, 'claude');
      assert.equal(patch.launchMode, 'default');
    });

    it('says the form may be out of date when the settings cannot be read back', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'), { patch: resetting });
      await form.open();
      form.moveEngine('codex');
      form.live.statusFails = true;
      await form.save();
      assert.match(form.group(), /could not be read back/);
      assert.match(form.group(), /does not carry to Codex/, 'the save\'s own answer is still shown');
    });

    it('shows no reset and reads nothing back when the save failed', async () => {
      const form = openForm(settingsOn('claude', 'bypassPermissions'), {
        patch: () => null,
        lastError: 'master.launchMode "fullAuto" is not a launch mode of Claude Code'
      });
      await form.open();
      form.moveEngine('codex');
      const drawn = form.group();
      await form.save();
      assert.equal(form.group(), drawn, 'the control is left as the operator had it');
      assert.equal(form.live.statusReads, 1, 'nothing changed, so nothing is read back');
      assert.equal(form.statusLine().textContent, 'master.launchMode "fullAuto" is not a launch mode of Claude Code');
      assert.match(form.statusLine().className, /rules-status-err/);
    });

    it('tolerates an answer with no warnings field', async () => {
      const form = openForm(settingsOn('claude', 'default'), { patch: () => ({ ok: true }) });
      await form.open();
      await form.save();
      assert.match(form.statusLine().textContent, /^Settings saved — /);
    });
  });

  describe('the modal\'s save, through the server\'s rule', () => {
    const store = require('../lib/store');
    const master = require('../lib/master');
    const { setLevel } = require('../lib/logger');
    let tmpDir;

    before(() => {
      setLevel('error');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-2197-ui-'));
      store._setBasePath(tmpDir);
      store.init();
    });
    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * What the server would hold after the modal's save, by its own rule.
     * @param {object} stored - The stored `master` launch fields: `engine`, `launchMode`, `launchModeEngine`.
     * @param {Function} act - Drives the opened form before the save.
     * @returns {Promise<object>} `masterLaunchModeAfterPatch`'s answer.
     */
    async function outcome(stored, act) {
      const before_ = { defaultEngine: 'claude', master: { accessLevel: 'read-only', scope: 'all', autoStart: false, ...stored } };
      const form = openForm(settingsOn(stored.engine, stored.launchMode, { launchModeEngine: stored.launchModeEngine }));
      await form.open();
      act(form);
      const patch = await form.save();
      const after_ = { ...before_, master: { ...before_.master, engine: patch.engine } };
      return master.masterLaunchModeAfterPatch(before_, after_, patch);
    }

    const BYPASS_ON_CLAUDE = { engine: 'claude', launchMode: 'bypassPermissions', launchModeEngine: 'claude' };

    it('an engine change with the mode left alone stores default for the new engine', async () => {
      const result = await outcome(BYPASS_ON_CLAUDE, (form) => form.moveEngine('codex'));
      assert.equal(result.error, null);
      assert.equal(result.launchMode, 'default');
      assert.equal(result.launchModeEngine, null);
    });

    it('an engine change with a mode picked stores that mode for the new engine', async () => {
      const result = await outcome(BYPASS_ON_CLAUDE, (form) => { form.moveEngine('codex'); form.pickMode('fullAuto'); });
      assert.equal(result.error, null);
      assert.equal(result.launchMode, 'fullAuto');
      assert.equal(result.launchModeEngine, 'codex');
      assert.equal(result.reset, null);
    });

    it('a save about something else leaves the mode alone and draws no notice', async () => {
      const result = await outcome(BYPASS_ON_CLAUDE, () => {});
      assert.equal(result.launchMode, 'bypassPermissions');
      assert.equal(result.launchModeEngine, 'claude');
      assert.equal(result.reset, null);
      assert.equal(result.unused, null);
    });

    it('is never refused for sending the old engine\'s mode to an engine that does not define it', async () => {
      // Before this, Accept Edits on Claude Code moved to Aider was a 400: the
      // modal sent `acceptEdits` with the new engine.
      const result = await outcome(
        { engine: 'claude', launchMode: 'acceptEdits', launchModeEngine: 'claude' },
        (form) => form.moveEngine('aider')
      );
      assert.equal(result.error, null);
      assert.equal(result.launchMode, 'default');
    });

    it('a stored mode that belongs to another engine is cleared by saving the form as shown', async () => {
      const result = await outcome(
        { engine: 'codex', launchMode: 'bypassPermissions', launchModeEngine: 'claude' },
        () => {}
      );
      assert.equal(result.error, null);
      assert.equal(result.launchMode, 'default');
      assert.equal(result.unused, null, 'so the notice that asks for exactly this is not drawn again');
    });
  });
});
