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
