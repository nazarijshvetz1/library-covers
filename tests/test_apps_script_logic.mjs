import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const context = vm.createContext({ console, Set, JSON, String, Boolean, RegExp, Math, Date });
vm.runInContext(source, context, { filename: 'Code.gs' });

assert.equal(
  context.shouldApplyCoverResult_('new-request', { request_id: 'old-request', success: true }),
  false,
  'A stale request_id must be ignored'
);
assert.equal(
  context.shouldApplyCoverResult_('new-request', { request_id: 'new-request', success: true }),
  true,
  'The current request_id must be accepted'
);
assert.equal(context.normalizeIsbn_('978-617 09-1234-5'), '9786170912345');

console.log('Apps Script pure-logic tests passed');
