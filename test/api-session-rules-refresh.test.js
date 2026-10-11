'use strict';

/*
 * #2273: shards are launch-time files — a mid-session status change must
 * rewrite the project's shards from the in-force set, or the next /clear
 * re-delivers stale rules. Approving writes the new rule in; retiring takes
 * it back out. The status change itself never fails on a shard write.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');
const { operatorHeaders } = require('./_shared-docs-callers');

setLevel('error');

describe('session-rules shard refresh on status change (#2273)', () => {
  let server;
  let port;
  let tmpDir;
  let projectId;
  let projPath;

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', ...operatorHeaders(server) }
      };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  function shardText() {
    const dir = path.join(projPath, '.tangleclaw');
    if (!fs.existsSync(dir)) return '';
    return fs.readdirSync(dir)
      .filter((n) => n.startsWith('session-rules-'))
      .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
      .join('\n');
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rules-refresh-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projPath = path.join(tmpDir, 'rules-proj');
    fs.mkdirSync(projPath, { recursive: true });
    projectId = store.projects.create({ name: 'rules-proj', path: projPath, engine: 'claude' }).id;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('approving a proposal writes it into the shards', async () => {
    const rule = store.sessionRules.create({
      content: `refresh-marker-${Date.now()}`, projectId, createdBy: 'ai'
    });
    const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
      { status: 'active', expectedContent: rule.content });
    assert.equal(res.status, 200);
    assert.ok(shardText().includes('refresh-marker-'),
      'approved rule must reach the on-disk shards');
  });

  it('retiring a rule takes it back out of the shards', async () => {
    const marker = `retire-marker-${Date.now()}`;
    const rule = store.sessionRules.create({ content: marker, projectId, createdBy: 'ai' });
    const approved = await request('PUT', `/api/session-rules/${rule.id}/status`,
      { status: 'active', expectedContent: rule.content });
    assert.equal(approved.status, 200);
    assert.ok(shardText().includes(marker));
    const retired = await request('PUT', `/api/session-rules/${rule.id}/status`,
      { status: 'retired' });
    assert.equal(retired.status, 200);
    assert.ok(!shardText().includes(marker),
      'retired rule must not be re-delivered from disk');
  });
});
