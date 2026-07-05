// AUTHORED-BY Claude Fable 5
//
// Minimal ambient types for `rdf-canonize` (the W3C reference RDF Dataset
// Canonicalization implementation), mirrored from `@jeswr/solid-a2a`'s shim.
// The package ships no `.d.ts` and there is no `@types/rdf-canonize`, so we
// declare only the sliver of its public API this package uses: the async
// `canonize(dataset, { algorithm: "RDFC-1.0" })` entry point documented in its
// README. It is a CommonJS module (`module.exports = { canonize, ... }`),
// hence `export =`.

declare module "rdf-canonize" {
  import type { Quad } from "@rdfjs/types";

  interface CanonizeOptions {
    /** The canonicalization algorithm. "URDNA2015" is a deprecated alias. */
    algorithm: "RDFC-1.0" | "URDNA2015";
    /** Set when `input` is a serialised N-Quads string rather than a dataset. */
    inputFormat?: "application/n-quads";
    /** Output serialisation (default N-Quads). */
    format?: "application/n-quads";
  }

  /**
   * Canonicalize an RDF dataset (array of RDF/JS quads) or an N-Quads string to
   * its canonical N-Quads serialisation. Resolves to the canonical string.
   */
  function canonize(input: readonly Quad[] | string, options: CanonizeOptions): Promise<string>;

  const rdfCanonize: { canonize: typeof canonize };
  export = rdfCanonize;
}
