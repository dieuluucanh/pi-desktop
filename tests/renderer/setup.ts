import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * Renderer-test setup (plan step 1).
 *
 * Vitest runs without globals here, so Testing Library's automatic cleanup is
 * not registered for us — without this the DOM accumulates between tests and
 * queries start finding duplicates.
 */
afterEach(cleanup);
