import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        URL: "readonly",
        Blob: "readonly",
        File: "readonly",
        Audio: "readonly",
        Image: "readonly",
        TextEncoder: "readonly",
        Uint8Array: "readonly",
        HTMLElement: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        self: "readonly",
        clients: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        indexedDB: "readonly",
        AbortController: "readonly",
        OfflineAudioContext: "readonly",
        getComputedStyle: "readonly",
        requestAnimationFrame: "readonly",
        prompt: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    ignores: ["node_modules/", "docs/coi-serviceworker.js"],
  },
];
