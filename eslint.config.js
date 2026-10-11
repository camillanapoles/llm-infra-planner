import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      '_site',
      // AssemblyScript sources are compiled by `asc`, not by tsc/eslint
      'wasm/**',
      // built wasm artifacts
      'public/wasm/**',
      'wasi/dist/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          // `useToast` mora junto do provider de propósito: 7 arquivos importam
          // o hook daqui. Componentes deste arquivo não participam do HMR.
          allowExportNames: ['useToast'],
        },
      ],
      // Convenção `_prefixo`: valor lido de propósito e descartado (ex.: cabeçalho
      // binário lido só para avançar o offset). Documentado em CONTRIBUTING.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Allow empty interfaces in primitive component files (extends pattern)
      '@typescript-eslint/no-empty-object-type': 'off',
      // Allow `any` in test files and legacy primitive components
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
    },
  },
)
