import nextConfig from "eslint-config-next";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "data/**",
      "tests/artifacts/**",
      "node_modules/**",
      ".chrome-verify-profile/**",
    ],
  },
  ...nextConfig,
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
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // Playwright fixtures/test files use Node-style "use" callback
      // parameters unrelated to React's `use()` hook; not React components.
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default eslintConfig;
