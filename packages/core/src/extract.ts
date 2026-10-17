// Static extraction: a node's code (page.tsx, layout.tsx, …) is the only source of truth; the manifest is derived from it at compile time.
// Declarations are module exports (agents, actions, config); hooks only use them. Imported nodes are
// components. The server never executes node code to learn what a node is.
//
// In extract/: declarations (and the manifest), "use server" exports, schedules, and the syntax tree they read.
export { agentsFrom, analyze, applyEdits, INSTALL_SOURCE, installSourceError, mergeManifest, NODE_SOURCE, type ActionDecl, type AgentDecl, type Extracted, type ImportDecl, type Manifest, type ToolDecl, type TriggerDecl, type UsageDecl, watchOf } from "./extract/declarations.ts";
export { isServerFile, serverExports, serverStub } from "./extract/server-exports.ts";
export { cronFields, everyMs } from "./extract/schedule.ts";
