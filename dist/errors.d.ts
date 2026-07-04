/**
 * `ChannelParseError` — the channel-neutral, typed, fail-closed parse refusal
 * (M2-DESIGN.md §M2.0). A {@link ChannelAdapter.parse} implementation throws (a
 * subclass of) this for an input it REFUSES to parse — over a hard cap, or
 * structurally unusable — and `importInbound` treats it as "skip this message,
 * never abort the batch" (M1's skip-don't-abort posture, generalised from
 * `EmailParseError`, which now extends this class).
 *
 * Deliberately a zero-dependency module: the `./email` subexport stays
 * dependency-light while sharing the class.
 */
/** A controlled, typed, fail-closed refusal thrown by a channel `parse`. */
export declare class ChannelParseError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map