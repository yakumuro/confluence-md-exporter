'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../lib/confluence-api');

test('updates the current storage body using the next page version', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  const calls = [];
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({
        id: '42',
        type: 'page',
        title: 'Example',
        space: { key: 'DOC' },
        version: { number: 7 },
        body: { storage: { value: '<p>Existing</p>' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: '42', title: 'Example', version: { number: 8 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await api.updatePage('42', '<p>Imported</p>', 'append');
    assert.equal(result.version, 8);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/rest\/api\/content\/42\?/);
    assert.equal(calls[1].options.method, 'PUT');
    assert.match(calls[1].url, /\/rest\/api\/content\/42$/);
    assert.equal(calls[1].options.headers['X-Atlassian-Token'], 'no-check');
    const payload = JSON.parse(calls[1].options.body);
    assert.equal(payload.version.number, 8);
    assert.equal(payload.body.storage.representation, 'storage');
    assert.equal(payload.body.storage.value, '<p>Existing</p>\n<p>Imported</p>');
    assert.deepEqual(payload.space, { key: 'DOC' });
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('prepends imported storage before existing page content', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  const calls = [];
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({
        id: '9', title: 'Page', version: { number: 2 }, body: { storage: { value: '<p>Old</p>' } }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: '9', version: { number: 3 } }), { status: 200 });
  };

  try {
    await api.updatePage('9', '<p>New</p>', 'prepend');
    assert.equal(JSON.parse(calls[1].options.body).body.storage.value, '<p>New</p>\n<p>Old</p>');
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('retries append from the exact server-reported historical version after HTTP 409', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  const calls = [];
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    if (options.method === 'GET') {
      const requestedVersion = new URL(url).searchParams.get('version');
      const version = requestedVersion ? Number(requestedVersion) : 3;
      const content = version === 7 ? '<p>Latest revision seven</p>' : '<p>Stale revision three</p>';
      return new Response(JSON.stringify({
        id: '42', type: 'page', title: 'Example', version: { number: version },
        body: { storage: { value: content } }
      }), { status: 200 });
    }
    if (calls.filter(function (call) { return call.options.method === 'PUT'; }).length === 1) {
      return new Response('{"message":"Version must be incremented on update. Current version is: 7."}', { status: 409 });
    }
    return new Response(JSON.stringify({ id: '42', title: 'Example', version: { number: 8 } }), { status: 200 });
  };

  try {
    const result = await api.updatePage('42', '<p>Imported</p>', 'append');
    assert.equal(result.version, 8);
    assert.equal(calls.length, 4);
    assert.match(calls[2].url, /version=7/);
    const firstPayload = JSON.parse(calls[1].options.body);
    assert.equal(firstPayload.version.number, 4);
    const retryPayload = JSON.parse(calls[3].options.body);
    assert.equal(retryPayload.version.number, 8);
    assert.equal(retryPayload.body.storage.value,
      '<p>Latest revision seven</p>\n<p>Imported</p>');
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('stops instead of resending a stale body when GET version disagrees with PUT current version', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  const calls = [];
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({
        id: '42', type: 'page', title: 'Example', version: { number: 3 },
        body: { storage: { value: '<p>Revision three</p>' } }
      }), { status: 200 });
    }
    return new Response('{"message":"Version must be incremented on update. Current version is: 7."}', { status: 409 });
  };

  try {
    await assert.rejects(api.updatePage('42', '<p>Imported</p>', 'append'), function (error) {
      return /текущую версию 7/.test(error.message)
        && /API чтения страницы возвращает версию 3/.test(error.message);
    });
    assert.match(calls[2].url, /version=7/);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter(function (call) { return call.options.method === 'PUT'; }).length, 1);
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('returns child-page loading failures so incomplete trees are visible', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url) {
    if (String(url).includes('/content/1/child/page')) {
      return new Response(JSON.stringify({ results: [{ id: '2', title: 'Child' }] }), { status: 200 });
    }
    return new Response('', { status: 403 });
  };

  try {
    const tree = await api.buildTree('1', { rootTitle: 'Root' });
    assert.equal(tree.errors.length, 1);
    assert.equal(tree.errors[0].id, '2');
    assert.equal(tree.errors[0].title, 'Child');
    assert.match(tree.errors[0].message, /Доступ запрещен/);
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('does not fetch attachment URLs from another origin with page credentials', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  let fetchCalled = false;
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function () {
    fetchCalled = true;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };

  try {
    await assert.rejects(api.fetchAttachmentBytes({ download: 'https://other.example.test/file.bin' }), /другой сайт/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});

test('does not duplicate a prepended block when retry reads a page that already contains it', async function () {
  const previous = { fetch: global.fetch, location: global.location, document: global.document };
  const calls = [];
  global.location = { origin: 'https://confluence.example.test', pathname: '/' };
  global.document = { querySelector: function () { return null; } };
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    if (options.method === 'GET') {
      const requestedVersion = new URL(url).searchParams.get('version');
      const version = requestedVersion ? Number(requestedVersion) : 2;
      return new Response(JSON.stringify({
        id: '9', title: 'Page', version: { number: version },
        body: { storage: { value: version === 2 ? '<p>Old</p>' : '<p>New</p>\n<p>Old</p>' } }
      }), { status: 200 });
    }
    return new Response('{"message":"Version must be incremented on update. Current version is: 3."}', { status: 409 });
  };

  try {
    const result = await api.updatePage('9', '<p>New</p>', 'prepend');
    assert.equal(result.version, 3);
    assert.equal(calls.filter(function (call) { return call.options.method === 'PUT'; }).length, 1);
  } finally {
    global.fetch = previous.fetch;
    if (previous.location === undefined) delete global.location;
    else global.location = previous.location;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
  }
});
