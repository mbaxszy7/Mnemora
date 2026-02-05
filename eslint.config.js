import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["dist/**", "dist-electron/**", "node_modules/**", "scripts/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // Disable react-refresh warning for UI components (shadcn/ui pattern)
    files: ["src/components/ui/**/*.{ts,tsx}", "src/pages/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  }
);
