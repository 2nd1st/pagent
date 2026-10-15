// @pagent/ax: the apps on this Mac, through the accessibility API. Not part of the core: a Mac-only capability built on
// it, shipped with the engine. Server code gets `ax` as `import { ax } from "pagent/server"`; the engine loads the rest
// by path (core engine.ts `ax`): the `pagent app …` commands, finding apps and new bridges for `pagent add --app`,
// filling a Secure Form's value into an app's field, watching an app for a trigger with `app`, and quitting an app it
// launched for a bridge with `quit: "after"`.
export { ax, fill, findField, launchedIn, quitLaunched, watch, type AxChange, type AxNode, type AxTarget, type AxTree, type AxWatch, type AxWatchOptions, type AxWatchState } from "./ax.ts";
export { appCommands, axTarget, type AppCommand, type Args } from "./commands.ts";
export { drivesNote, findMacApp, folderFor, newBridge } from "./bridges.ts";
