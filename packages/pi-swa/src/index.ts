// @saras/pi-swa: SWA, the software architect's assistant, as a Pi extension (docs/15_SWA_Extension.md).
// Hosts: the VS Code coding agent and plain pi (arch/ on disk, store.ts FsArchStore), and the
// runtime (arch/ as arena or private-chat documents). A host loads createSwaExtension() next to
// its own extension, adds SWA_TOOL_NAMES to its tool allowlist, and hands swaResources().skills and
// .prompts to Pi.

export * from './approve.js';
export * from './extension.js';
export * from './layout.js';
export * from './markdown.js';
export * from './resources.js';
export * from './state.js';
export * from './store.js';
export * from './writes.js';
