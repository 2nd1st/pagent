// Reading code without running it: a module's syntax tree (Babel), and where a node of it is.
import { parse } from "@babel/parser";

export type Node = { type: string; start: number; end: number; [k: string]: any };

export function parseModule(code: string) {
  return parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
}

export function lineOf(code: string, pos: number) {
  return code.slice(0, pos).split("\n").length;
}
