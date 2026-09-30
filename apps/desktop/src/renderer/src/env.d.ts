/// <reference types="vite/client" />

import type {
  AiCredentialResult,
  AiCredentialSetRequest,
  AiEgressAckRequest,
  AiEgressAckResult,
  AppCommand,
  AppInfo,
  CredentialStatus,
  FlushResult,
  PickDirectoryRequest,
  PickDirectoryResult,
  Settings,
  SettingsPatch,
  SidecarConnection,
  SidecarStatus,
} from '@inkstone/shared';

declare global {
  interface Window {
    inkstone: {
      app: {
        getInfo(): Promise<AppInfo>;
        onBeforeQuit(callback: () => void): () => void;
        sendFlushResult(result: FlushResult): void;
        /** 菜单命令（09 文档 §4.4） */
        onCommand(callback: (command: AppCommand) => void): () => void;
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
      settings: {
        get(): Promise<Settings>;
        set(patch: SettingsPatch): Promise<Settings>;
        onChanged(callback: (settings: Settings) => void): () => void;
      };
      /**
       * 凭据（11 文档 §4.4）。刻意**没有** `getCredential` ——
       * 渲染进程只能问"配了没有"，拿不到 Key 本身。
       */
      ai: {
        getCredentialsStatus(): Promise<CredentialStatus[]>;
        isSecureStorageAvailable(): Promise<boolean>;
        setCredential(req: AiCredentialSetRequest): Promise<AiCredentialResult>;
        clearCredential(providerId: string): Promise<AiCredentialResult>;
        /**
         * 记录 / 撤销"已确认可以把内容发往这家"（11 文档 §2.3）。
         *
         * 只表达"加一个 / 去一个"的意图，名单本身归主进程 —— 渲染进程读不到整个数组，
         * 也就不会出现"两处都改、后写的覆盖先写的"。
         */
        setEgressAck(req: AiEgressAckRequest): Promise<AiEgressAckResult>;
      };
    };
  }
}

export {};
