module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  forceExit: true,
  detectOpenHandles: false,
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "orchestration/**/*.ts",
    "runtime/**/*.ts",
    "!orchestration/interfaces/**",
    "!**/*.d.ts"
  ],
  coverageReporters: ["text-summary", "lcov", "html"],
  coverageThreshold: {
    global: {
      lines: 60,
      functions: 60
    }
  }
};
