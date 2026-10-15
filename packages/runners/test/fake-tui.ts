#!/usr/bin/env node
// The fake runner (fake.ts) with a TUI: it says its turns are typed into the agent's terminal ("describe"), opens a fake
// TUI there ("interactive") and follows its transcript ("follow"), as a runner for Claude Code does.
(globalThis as { FAKE_TURNS?: string }).FAKE_TURNS = "tui";
await import("./fake.ts");
