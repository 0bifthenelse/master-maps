const eslintConfig = [
  {
    ignores: [".next/**", "data/**", "tests/artifacts/**", "**/*.ts", "**/*.tsx"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
];

export default eslintConfig;