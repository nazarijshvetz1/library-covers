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
assert.equal(context.isValidCatId_('CAT-0922'), true);
assert.equal(context.isValidCatId_('CAT-92'), false);
assert.equal(
  context.chooseResolvedCatId_('CAT-0922', 'CAT-0004', 'CAT-0100', true),
  'CAT-0922',
  'An explicitly prepared existing CAT-ID must win'
);
assert.equal(
  context.chooseResolvedCatId_('', 'CAT-1278', 'CAT-0100', true),
  'CAT-1278',
  'A master-row CAT-ID must be accepted outside the new-book block'
);
assert.equal(
  context.chooseResolvedCatId_('', 'CAT-0004', 'CAT-1278', false),
  'CAT-1278',
  'A CAT-ID from the overlapping new-book rows must not replace the ISBN match'
);
assert.equal(
  context.chooseExistingCoverSource_('https://example.com/direct.jpg', 'https://example.com/page'),
  'https://example.com/direct.jpg'
);
assert.equal(
  context.chooseExistingCoverSource_('', 'https://example.com/page'),
  'https://example.com/page'
);
assert.equal(context.chooseExistingCoverSource_('', 'file:///cover.jpg'), '');

console.log('Apps Script pure-logic tests passed');

