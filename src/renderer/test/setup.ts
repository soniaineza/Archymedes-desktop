import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { createFakeApi } from "./fake-api";

beforeEach(() => {
  window.archymedes = createFakeApi();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});
