/**
 * The deprecated `pi-worklist` Pi extension entry point.
 *
 * Re-exported rather than reimplemented so an existing `pi install
 * npm:pi-worklist` keeps loading the real extension, with no second copy of the
 * behavior to drift.
 */

export * from "stepstone/src/extension.ts";
export { default } from "stepstone/src/extension.ts";
