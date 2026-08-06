import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const context = vm.createContext({
  console,
  Set,
  JSON,
  String,
  Boolean,
  RegExp,
  Math,
  Date,
  Object,
  Array,
  Number,
  Error,
  parseInt,
});
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

assert.equal(context.isSafePublicUrlCandidate_('https://example.com/cover.jpg'), true);
assert.equal(context.isSafePublicUrlCandidate_('http://localhost/cover.jpg'), false);
assert.equal(context.isSafePublicUrlCandidate_('http://127.0.0.1/cover.jpg'), false);
assert.equal(context.isSafePublicUrlCandidate_('http://10.0.0.1/cover.jpg'), false);
assert.equal(context.isSafePublicUrlCandidate_('http://172.20.1.2/cover.jpg'), false);
assert.equal(context.isSafePublicUrlCandidate_('http://192.168.1.2/cover.jpg'), false);
assert.equal(context.isSafePublicUrlCandidate_('http://169.254.169.254/latest/meta-data'), false);
assert.equal(context.isSafePublicUrlCandidate_('https://user@example.com/cover.jpg'), false);

assert.equal(
  context.resolveRelativeUrl_('/images/cover.jpg', 'https://example.com/books/item'),
  'https://example.com/images/cover.jpg'
);
assert.equal(
  context.resolveRelativeUrl_('../images/cover.jpg?size=large', 'https://example.com/books/item/'),
  'https://example.com/books/images/cover.jpg?size=large'
);
assert.equal(
  context.extractImageUrlFromHtml_(
    '<meta property="og:image" content="/covers/book.jpg?x=1&amp;y=2">',
    'https://example.com/product/1'
  ),
  'https://example.com/covers/book.jpg?x=1&y=2'
);
assert.equal(
  context.extractImageUrlFromHtml_(
    '<meta content="https://cdn.example.com/twitter.png" name="twitter:image">',
    'https://example.com/product/1'
  ),
  'https://cdn.example.com/twitter.png'
);
assert.equal(
  context.extractImageUrlFromHtml_(
    '<script type="application/ld+json">{"@type":"Product","image":{"url":"/json/cover.png"}}</script>',
    'https://example.com/product/1'
  ),
  'https://example.com/json/cover.png'
);

console.log('Apps Script pure-logic tests passed');

