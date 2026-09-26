import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/i18n.ts", "utf8");
const enBody = source.slice(source.indexOf("const en: Dict = {"), source.indexOf("const tr: Dict = {"));
const trBody = source.slice(source.indexOf("const tr: Dict = {"), source.indexOf("const dictionaries"));

const keysOf = (body) => {
  const keys = [];
  for (const match of body.matchAll(/^\s*"([^"]+)":/gm)) keys.push(match[1]);
  return keys;
};

const enKeys = keysOf(enBody);
const trKeys = new Set(keysOf(trBody));
const missing = enKeys.filter((key) => !trKeys.has(key));
const extra = [...trKeys].filter((key) => !enKeys.includes(key));
console.log("en:", enKeys.length, "tr:", trKeys.size, "missing-in-tr:", missing.length, "extra-in-tr:", extra.length);
const out = enKeys.map((k) => { const line = enBody.split("\n").find((e) => e.trim().startsWith(`"${k}":`)); return k + "\t" + (line ? line.trim().slice(line.indexOf(":") + 1).trim().replace(/,$/, "").replace(/^"|"$/g, "") : "?"); }).join("\n"); console.log(out);