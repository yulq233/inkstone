/// <reference types="vite/client" />

import type {
  AppInfo,
  PickDirectoryRequest,
  PickDirectoryResult,
  SidecarConnection,
  SidecarStatus,
} from '@inkstone/shared';

declare global {
  interface Window {
    inkstone: {
      app: {
        getInfo(): Promise<AppInfo>;
      };
      sidecar: {
        getConnection(): Promise<SidecarConnection | null>;
        getStatus(): Promise<SidecarStatus>;
        onStatus(callback: (status: SidecarStatus) => void): () => void;
        devCrash(): Promise<void>;
      };
      dialog: {
        pickDirectory(req: PickDirectoryRequest): Promise<PickDirectoryResult>;
      };
    };
  }
}

export {};
