module.exports = [
  {
    type: "input",
    name: "name",
    message: "UI component name (kebab-case, e.g. button, card):",
    validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || "Use kebab-case (lowercase, hyphens)",
  },
];
