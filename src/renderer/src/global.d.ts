import type { ArchymedesApi } from "@shared/types";

declare global {
  interface Window {
    archymedes: ArchymedesApi;
  }
}

export {};
