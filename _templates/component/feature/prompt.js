module.exports = [
  {
    type: "input",
    name: "name",
    message: "Component name (PascalCase, e.g. ModelCard):",
    validate: (v) => /^[A-Z][A-Za-z0-9]+$/.test(v) || "Use PascalCase",
  },
  {
    type: "input",
    name: "feature",
    message: "Feature directory (e.g. canvas, models, workspace):",
    validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || "Use kebab-case",
  },
];
