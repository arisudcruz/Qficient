import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const output = resolve(root, "dist");

mkdirSync(output, { recursive: true });
cpSync(resolve(root, "js"), resolve(output, "js"), { recursive: true });
cpSync(resolve(root, "views"), resolve(output, "views"), { recursive: true });
cpSync(resolve(root, "assets"), resolve(output, "assets"), { recursive: true });
