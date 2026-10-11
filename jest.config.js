module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 30000,
  // mongodb-memory-server starts a real mongod; give it room, no mocks involved.
  verbose: true,
};
