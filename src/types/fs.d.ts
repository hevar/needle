/** The part of Node.js that Needle uses on desktop, where Obsidian provides `require`. */
declare const require: (id: "fs/promises") => unknown;

declare module "fs/promises" {
	export const stat: (path: string) => Promise<{ size: number; blocks: number }>;
}
