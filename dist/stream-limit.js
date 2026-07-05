// AUTHORED-BY Claude Fable 5
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
export async function readAllBounded(stream, maxBytes) {
    if (stream === null || stream === undefined)
        return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value === undefined)
                continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => { });
                return undefined; // exceeded the cap — do NOT materialise the rest
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
//# sourceMappingURL=stream-limit.js.map