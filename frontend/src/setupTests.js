// Registers jest-dom matchers (toBeInTheDocument, ...) with Vitest's expect,
// and unmounts rendered components after each test.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
