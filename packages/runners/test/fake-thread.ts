#!/usr/bin/env node
// The fake runner (fake.ts) on a shared thread: it says its turns go to a thread ("describe"), keeps a service in the
// daemon ("service"), and runs each agent as a long-lived client of its thread ("session"), which a TUI joins as one
// more client ("interactive"), as the runner for Codex does.
(globalThis as { FAKE_TURNS?: string }).FAKE_TURNS = "thread";
await import("./fake.ts");
