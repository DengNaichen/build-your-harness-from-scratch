// Run from the repo root:  node lessons/01-edit/size.ts
// What the model must emit to change ONE line of a 600-line file.
const lines: string[] = [];
for (let i = 1; i <= 600; i++) lines.push(`export function fn${i}(a: number, b: number) { return a + b + ${i}; }`);
const file = lines.join("\n") + "\n";

const oldText = "return a + b + 300;";
const newText = "return a + b + 3000;";

const writeArgs = JSON.stringify({ path: "math.ts", content: file.replace(oldText, newText) });
const editArgs = JSON.stringify({ path: "math.ts", old_string: oldText, new_string: newText });

console.log("file:", lines.length, "lines,", Buffer.byteLength(file), "bytes");
console.log("write call arguments:", Buffer.byteLength(writeArgs), "bytes");
console.log("edit  call arguments:", Buffer.byteLength(editArgs), "bytes");
console.log("ratio:", Math.round(Buffer.byteLength(writeArgs) / Buffer.byteLength(editArgs)) + "x");
