/**
 * dependency-cruiser config for abacus's circular-dependency gate.
 *
 * Enforces only the `no-circular` rule: any import cycle is an error.
 * Uses the repo's tsconfig.json for module resolution when present.
 * Extend this file in your repo to add project-specific rules or exemptions.
 */
const fs = require("node:fs");
const path = require("node:path");

const tsConfigPath = path.join(process.cwd(), "tsconfig.json");

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "This dependency is part of a circular relationship. " +
        "Revise the module structure (dependency inversion, single responsibility).",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    ...(fs.existsSync(tsConfigPath) ? { tsConfig: { fileName: tsConfigPath } } : {}),
  },
};
