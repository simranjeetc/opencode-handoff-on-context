// Plugin entry point.
//
// IMPORTANT: OpenCode's plugin loader invokes EVERY function export of this
// module as a plugin factory (calling it with PluginInput). Any helper
// exported here — e.g. startHandoff — would be called as a factory, hit
// writeFileSync(path, undefined), and throw a TypeError on every boot. So
// this module must expose exactly ONE function: the plugin itself, as the
// default export. All helpers live in lib.js (imported by tests) and never
// reach the loader.
export { HandoffOnContextPlugin as default } from "./lib.js";
