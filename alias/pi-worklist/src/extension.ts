/**
 * The deprecated `pi-worklist` Pi extension entry point.
 *
 * Re-exported rather than reimplemented so an existing `pi install
 * npm:pi-worklist` keeps loading the real extension, with no second copy of the
 * behavior to drift. The forward goes through `stepstone`'s root export, which
 * its manifest maps to this same module, so nothing here rests on a subpath
 * pattern or on a `.ts` extension surviving the harness loader.
 */

export * from "stepstone";
export { default } from "stepstone";
