import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, stat } from 'node:fs/promises';
import { videoRange, VIDEO_SIZES } from '../src/video-range.ts';

// The Worker smoke check exercises the real FixedLengthStream. Node's unit
// tests use an identity pair and independently compare the resulting bytes.
globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor() { super(); }
};
const bytes = new TextEncoder().encode('0123456789');
const url = 'https://bountyoperator.com/videos/product-tour.mp4';
const asset = (options = {}) => new Response(bytes, {
  headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', ETag: '"example"', ...options.headers },
  ...(options.status ? { status: options.status } : {}),
});
const request = (range, options = {}) => new Request(url, { ...options, headers: { ...(range ? { Range: range } : {}), ...options.headers } });

test('the fallback lengths match the exact shipped video files', async () => {
  const shippedVideos = (await readdir(new URL('../public/videos/', import.meta.url)))
    .filter(name => name.endsWith('.mp4')).map(name => `/videos/${name}`).sort();
  assert.deepEqual(Object.keys(VIDEO_SIZES).sort(), shippedVideos, 'every shipped video must support seeking');
  for (const [path, length] of Object.entries(VIDEO_SIZES)) {
    const file = new URL(`../public${path}`, import.meta.url);
    assert.equal((await stat(file)).size, length, path);
    const response = videoRange(asset(), request('bytes=2-5'), path);
    assert.equal(response.status, 206, path);
    assert.equal(await response.text(), '2345', path);
  }
  const original = new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } });
  const response = videoRange(original, request('bytes=0-2'), new URL(url).pathname);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), `bytes 0-2/${VIDEO_SIZES[new URL(url).pathname]}`);
  assert.equal(await response.text(), '012');
});

test('video ranges deliver the exact inclusive interval, open interval and suffix', async () => {
  for (const [range, expected, interval] of [
    ['bytes=2-5', '2345', '2-5'], ['bytes=7-', '789', '7-9'],
    ['bytes=-3', '789', '7-9'], ['bytes=0-0', '0', '0-0'],
    ['bytes=0-999', '0123456789', '0-9'], ['bytes=-999', '0123456789', '0-9'],
  ]) {
    const response = videoRange(asset(), request(range), new URL(url).pathname);
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), `bytes ${interval}/10`);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');
    assert.equal(await response.text(), expected);
  }
});

test('unsatisfiable video ranges return 416 with the representation length', async () => {
  for (const range of ['bytes=10-', 'bytes=8-3', 'bytes=-0', 'bytes=999999999999999999999999-']) {
    const response = videoRange(asset(), request(range), new URL(url).pathname);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
});

test('unsupported ranges fall back to the complete file', async () => {
  for (const range of [undefined, 'items=0-1', 'bytes=0-1,4-5', 'bytes=NaN-8', 'bytes=-']) {
    const response = videoRange(asset(), request(range), new URL(url).pathname);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(await response.text(), '0123456789');
  }
});

test('If-Range requires the current strong validator', async () => {
  for (const validator of ['"old"', 'W/"example"', 'Sun, 11 Oct 2026 00:00:00 GMT']) {
    const response = videoRange(asset(), request('bytes=2-5', { headers: { 'If-Range': validator } }), new URL(url).pathname);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  }
  const response = videoRange(asset(), request('bytes=2-5', { headers: { 'If-Range': '"example"' } }), new URL(url).pathname);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
});

test('HEAD, other files and upstream partial or failed responses are not sliced', async () => {
  assert.equal(videoRange(asset(), request('bytes=2-5', { method: 'HEAD' }), new URL(url).pathname).status, 200);
  for (const path of ['/dl/package.tgz', '/videos/poster.jpg', '/private.mp4']) {
    const original = asset();
    assert.equal(videoRange(original, request('bytes=2-5'), path), original);
  }
  for (const original of [asset({ status: 206 }), asset({ status: 404 }), asset({ headers: { 'Content-Encoding': 'gzip' } }), asset({ headers: { 'Content-Length': 'unknown' } }), asset({ headers: { 'Content-Type': 'text/html' } })]) {
    assert.equal(videoRange(original, request('bytes=2-5'), new URL(url).pathname), original);
  }
});

test('a range spans source chunks and cancels before reading the whole asset', async () => {
  let cursor = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (cursor >= 100) return controller.close();
      controller.enqueue(bytes.slice(cursor % 10, cursor % 10 + 2));
      cursor += 2;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const original = new Response(body, { headers: { 'Content-Length': '100', 'Content-Type': 'video/mp4' } });
  const response = videoRange(original, request('bytes=3-6'), new URL(url).pathname);
  assert.equal(await response.text(), '3456');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.ok(cursor < 100, 'the rest of the asset was not buffered');
});
