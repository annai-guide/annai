import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, normPrefix, matchPath, typeForPath, isTextType, isCompressedType, PathError } from '../../src/core/paths.js';

test('normPath adds the leading slash and keeps valid paths', () => {
  assert.equal(normPath('notes/day1.md'), '/notes/day1.md');
  assert.equal(normPath('/notes/案内.md'), '/notes/案内.md');
});

test('normPath rejects empty, dot and dot-dot segments, backslashes, control characters and long paths', () => {
  for (const bad of ['/', '/a//b', '/a/./b', '/a/../b', '/a\\b', '/a\u0000b', '/a/', '/' + 'x'.repeat(600)]) {
    assert.throws(() => normPath(bad), PathError, bad);
  }
});

test('normPath reserves the .annai folder used inside archives', () => {
  assert.throws(() => normPath('/.annai/events.jsonl'), PathError);
  assert.equal(normPath('/notes/.annai'), '/notes/.annai');
});

test('normPrefix accepts the root and folder prefixes', () => {
  assert.equal(normPrefix(''), '/');
  assert.equal(normPrefix('/'), '/');
  assert.equal(normPrefix('plan/'), '/plan/');
  assert.throws(() => normPrefix('/a/../b/'), PathError);
});

test('matchPath: * stays inside one segment, ** spans segments', () => {
  assert.equal(matchPath('/plan/*.json', '/plan/a.json'), true);
  assert.equal(matchPath('/plan/*.json', '/plan/x/a.json'), false);
  assert.equal(matchPath('/files/**', '/files/a/b.jpg'), true);
  assert.equal(matchPath('/**/*.md', '/a.md'), true);
  assert.equal(matchPath('/**/*.md', '/notes/day/a.md'), true);
  assert.equal(matchPath('/trip.json', '/trip.json'), true);
  assert.equal(matchPath('/trip.json', '/tripXjson'), false);
});

test('typeForPath and the type predicates', () => {
  assert.equal(typeForPath('/a.json'), 'application/json');
  assert.equal(typeForPath('/a.MD'), 'text/markdown');
  assert.equal(typeForPath('/photo.JPG'), 'image/jpeg');
  assert.equal(typeForPath('/plugin/index.js'), 'text/javascript');
  assert.equal(typeForPath('/noext'), 'application/octet-stream');
  assert.equal(isTextType('application/json'), true);
  assert.equal(isTextType('image/png'), false);
  assert.equal(isCompressedType('image/jpeg'), true);
  assert.equal(isCompressedType('image/svg+xml'), false);
  assert.equal(isCompressedType('text/markdown'), false);
});

test('normPath keeps names in one Unicode form (NFC)', () => {
  assert.equal(normPath('/files/ガイド.png'.normalize('NFD')), '/files/ガイド.png'.normalize('NFC'));
});

test('emails are text', () => {
  assert.equal(typeForPath('/files/booking.eml'), 'message/rfc822');
  assert.equal(isTextType('message/rfc822'), true);
});
