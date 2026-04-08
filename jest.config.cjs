// jest.config.cjs — CommonJS config required because package.json has "type": "module"
// ts-jest overrides tsconfig module to CommonJS for test compilation only.
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          allowImportingTsExtensions: false,
          noEmit: false,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Strip .js extensions from imports (used by bundler-mode TS)
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
};
