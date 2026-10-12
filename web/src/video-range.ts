// The asset binding does not expose Content-Length inside the Worker. Pin the
// shipped lengths here; the tests check them against every public MP4 file.
export const VIDEO_SIZES: Readonly<Record<string, number>> = Object.freeze({
  '/videos/product-tour.mp4': 2613315,
  '/videos/mcp-walkthrough.mp4': 2761176,
  '/videos/spec-intro.mp4': 15204817,
});

/** Add single byte ranges to the walkthrough assets when the asset binding returns a full file. */
export function videoRange(asset: Response, request: Request, pathname: string): Response {
  if (!Object.hasOwn(VIDEO_SIZES, pathname) || asset.status !== 200 || !asset.body || asset.headers.has('Content-Encoding') || asset.headers.get('Content-Type')?.split(';')[0] !== 'video/mp4') return asset;
  const declared = asset.headers.get('Content-Length');
  const size = declared === null ? VIDEO_SIZES[pathname] : Number(declared);
  if (!Number.isSafeInteger(size) || size <= 0) return asset;

  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  const whole = () => new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  if (request.method !== 'GET') return whole();

  const ifRange = request.headers.get('If-Range');
  // Only a matching strong ETag validates a partial response. Unknown dates
  // and stale or weak validators fall back to the complete representation.
  if (ifRange && (ifRange.startsWith('W/') || ifRange !== asset.headers.get('ETag'))) return whole();
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range')?.trim() ?? '');
  // Unsupported units, malformed headers and multipart requests may be ignored.
  if (!match || (!match[1] && !match[2])) return whole();

  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start >= size || end < start) {
    void asset.body.cancel().catch(() => {});
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }

  const length = end - start + 1;
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(length));
  let offset = 0;
  const slice = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const from = Math.max(0, start - offset);
      const to = Math.min(chunk.byteLength, end + 1 - offset);
      if (to > from) controller.enqueue(chunk.subarray(from, to));
      offset += chunk.byteLength;
      // Stop the upstream read as soon as the requested interval is complete.
      if (offset > end) controller.terminate();
    },
  });
  // Workers derives Content-Length from the body; a plain stream would drop
  // the explicit header. This also detects an unexpectedly truncated asset.
  const body = asset.body.pipeThrough(slice).pipeThrough(new FixedLengthStream(length));
  return new Response(body, { status: 206, statusText: 'Partial Content', headers });
}
