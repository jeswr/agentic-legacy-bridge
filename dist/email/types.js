// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Typed shapes for a parsed inbound email. The ENTIRE input is untrusted, so every
 * field here is the RESULT of hardened parsing — display names/subject/body are
 * decoded then control-stripped, addresses are best-effort extracted (validity is
 * re-checked downstream before an address becomes an identity key or `mailto:` IRI),
 * and the raw bytes are never re-emitted (only their digest travels, as the
 * provenance anchor).
 */
export {};
//# sourceMappingURL=types.js.map