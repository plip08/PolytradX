import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // base.ts throws at import time if CTF_EXCHANGE_ADDRESS is unset; provide a dummy
    // so service modules can be imported under test (no network calls are made).
    env: {
      CTF_EXCHANGE_ADDRESS: '0x0000000000000000000000000000000000000001',
    },
  },
});
