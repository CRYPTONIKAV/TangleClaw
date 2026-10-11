'use strict';

/*
 * #2269: injectCommand must refuse a pane whose project has a running wrap
 * in wrap-run-registry, with its own refusal code — the way it refuses a
 * startup dialog. A line ending in Enter typed mid-wrap lands in whatever
 * the wrap is doing. Unreadable registry withholds (fail-closed, like
 * medusa-wake).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const sessions = require('../lib/sessions');
const wrapRuns = require('../lib/wrap-run-registry');

const COMPOSER = Object.freeze(['$ ', '']);

describe('injectCommand refuses a wrap-running pane (#2269)', () => {
  let base;
  let project;
  let typed;
  const real = { hasSession: tmux.hasSession, capturePane: tmux.capturePane, sendKeys: tmux.sendKeys };

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-refusal-'));
    store._setBasePath(base);
    store.init();
    project = store.projects.create({ name: 'wrap-proj', path: path.join(base, 'wrap-proj'), engine: 'claude' });
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'wrap-proj' });
    tmux.hasSession = () => true;
    tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
    tmux.sendKeys = (_name, text) => { typed.push(text); };
  });

  beforeEach(() => {
    typed = [];
    wrapRuns._resetForTests();
  });

  after(() => {
    Object.assign(tmux, real);
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('types normally when no wrap is running', () => {
    const res = sessions.injectCommand(project.name, 'ls');
    assert.deepEqual(res, { ok: true, error: null });
    assert.deepEqual(typed, ['ls']);
  });

  it('refuses with its own code while a wrap runs, typing nothing', () => {
    const begun = wrapRuns.begin(project.name, 1, {});
    assert.equal(begun.ok, true);
    const res = sessions.injectCommand(project.name, 'ls');
    assert.equal(res.ok, false);
    assert.match(res.error, /^WRAP_RUNNING: /);
    assert.equal(res.wrapRunning, true);
    assert.deepEqual(typed, []);
  });

  it('withholds when the registry cannot be read', () => {
    const realGet = wrapRuns.get;
    wrapRuns.get = () => { throw new Error('store is closed'); };
    try {
      const res = sessions.injectCommand(project.name, 'ls');
      assert.equal(res.ok, false);
      assert.match(res.error, /^WRAP_RUNNING: /);
      assert.deepEqual(typed, []);
    } finally {
      wrapRuns.get = realGet;
    }
  });
});
