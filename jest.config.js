module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
          transform: {
            useDefineForClassFields: false,
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          target: "ES2021",
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  roots: ["<rootDir>/src"],
  testPathIgnorePatterns: ["/node_modules/", "/.medusa/"],
}
