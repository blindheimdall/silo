// Values that fill an address, like an id or a file path, can come from an app's answer or a resident.
// "." and ".." stay the same when encoded and would move the call to another address of the API, with your key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '../connectors.mjs';

test('ids and paths made of dots never move a call to another address', async () => {
  let calls = 0;
  const ctx = new Proxy({}, { get: () => () => { calls++; throw Error('no call should be made'); } });
  await assert.rejects(runAction('github', 'file', { repo: 'acme/plant', path: '../../../user/emails' }, ctx), /without \. or \.\./);
  await assert.rejects(runAction('github', 'file', { repo: 'acme/plant', path: 'docs\\..\\..' }, ctx), /without \. or \.\./);
  await assert.rejects(runAction('github', 'close_issue', { repo: '../..', number: 1 }, ctx), /owner\/name/);
  await assert.rejects(runAction('github', 'comment', { repo: 'acme/..', number: 1, text: 'x' }, ctx), /owner\/name/);
  await assert.rejects(runAction('google', 'mail_read', { id: '..' }, ctx), /not a valid value/);
  await assert.rejects(runAction('microsoft', 'mail_read', { id: ' . ' }, ctx), /not a valid value/);
  await assert.rejects(runAction('notion', 'append', { id: '..', text: 'x' }, ctx), /not a valid value/);
  assert.equal(calls, 0);
});

