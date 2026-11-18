// A suite's first render pays for transforming every module it reaches on a cold jest
// cache (always, on CI): ~1.5s for an artifact page, past the 1s findBy/waitFor
// default. Wait up to 5s instead, inside a 15s test timeout (jest.config.js).
require('@testing-library/react-native').configure({ asyncUtilTimeout: 5000 })
