import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

export const execFile = promisify(execFileCallback);
export const repoRootUrl = new URL("../../..", import.meta.url);
export const repoRootPath = repoRootUrl.pathname;
export const cliPath = new URL("../../../dist/cli.js", import.meta.url).pathname;
