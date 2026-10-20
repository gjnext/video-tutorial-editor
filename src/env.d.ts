/// <reference types="vite/client" />
import type { StudioAPI } from '../shared/ipc';

declare global {
  interface Window {
    studio: StudioAPI;
  }
}
export {};
