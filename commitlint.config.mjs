export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Long, descriptive bodies are encouraged here — warn, don't fail.
    "body-max-line-length": [1, "always", 200],
    "footer-max-line-length": [1, "always", 200],
  },
};
