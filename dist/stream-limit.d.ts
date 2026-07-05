/**
 * A bounded body reader — read a `ReadableStream` into memory but ABORT (cancel the
 * stream) the moment the cumulative size exceeds a cap, so an oversized/unbounded
 * payload can never force full buffering + memory pressure BEFORE the size gate runs
 * (the webhook adapter's raw-request body and the upgrade transport's response both use
 * it). Returns the bytes, or `undefined` when the cap is exceeded (the caller answers
 * 413 / throws — fail-closed).
 */
/**
 * Read `stream` into a single `Uint8Array`, aborting once more than `maxBytes` have
 * been read. A `null`/`undefined` stream (an empty body) yields an empty array. On
 * overflow the stream is cancelled and `undefined` is returned.
 */
export declare function readAllBounded(stream: ReadableStream<Uint8Array> | null | undefined, maxBytes: number): Promise<Uint8Array | undefined>;
//# sourceMappingURL=stream-limit.d.ts.map