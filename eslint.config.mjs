import eslint from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const chineseUnitTestDescriptionRule = {
  meta: {
    type: 'problem',
    docs: {
      description: '要求单元测试描述包含中文',
    },
    schema: [],
  },
  create(context) {
    const hasChinese = (value) => /[\u3400-\u9fff]/u.test(value)

    const checkDescription = (argument) => {
      if (!argument) {
        return
      }
      let description
      if (argument.type === 'Literal' && typeof argument.value === 'string') {
        description = argument.value
      } else if (argument.type === 'TemplateLiteral') {
        description = argument.quasis.map((quasi) => quasi.value.cooked ?? '').join('')
      }
      if (description !== undefined && !hasChinese(description)) {
        context.report({ node: argument, message: '单元测试描述必须使用中文。' })
      }
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          ['describe', 'it', 'test'].includes(node.callee.name)
        ) {
          checkDescription(node.arguments[0])
          return
        }

        // 处理 describe.each([...])('描述', fn) / it.each([...])('描述', fn)。
        if (
          node.callee.type === 'CallExpression' &&
          node.callee.callee.type === 'MemberExpression' &&
          !node.callee.callee.computed &&
          node.callee.callee.property.type === 'Identifier' &&
          node.callee.callee.property.name === 'each' &&
          node.callee.callee.object.type === 'Identifier' &&
          ['describe', 'it', 'test'].includes(node.callee.callee.object.name)
        ) {
          checkDescription(node.arguments[0])
        }
      },
    }
  },
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.cache/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
      'evals/runs/**',
      'evals/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      curly: ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
    },
  },
  {
    files: ['tests/unit/**/*.{ts,tsx}'],
    plugins: {
      codeden: {
        rules: {
          'chinese-test-description': chineseUnitTestDescriptionRule,
        },
      },
    },
    rules: {
      'codeden/chinese-test-description': 'error',
    },
  },
)
