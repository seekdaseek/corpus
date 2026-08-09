// Compiles contracts/ with solc-js (wasm). evmVersion "paris" — no PUSH0 —
// so bytecode runs on zkEVMs regardless of their Shanghai support status.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "contracts");
const OUT = path.join(ROOT, "artifacts");

function findImports(importPath) {
  try {
    let full;
    if (importPath.startsWith("@openzeppelin/")) {
      full = path.join(ROOT, "node_modules", importPath);
    } else {
      full = path.join(SRC, importPath);
    }
    return { contents: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { error: "not found: " + importPath };
  }
}

function main() {
  const sources = {};
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".sol"))) {
    sources[f] = { content: fs.readFileSync(path.join(SRC, f), "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of Object.keys(out.contracts)) {
    for (const name of Object.keys(out.contracts[file])) {
      const c = out.contracts[file][name];
      fs.writeFileSync(
        path.join(OUT, `${name}.json`),
        JSON.stringify({ contractName: name, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
      );
      console.log(`compiled ${name} (${(c.evm.bytecode.object.length / 2).toLocaleString()} bytes)`);
    }
  }
}
main();
