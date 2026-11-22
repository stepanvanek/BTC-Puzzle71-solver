import { initializeApp } from 'firebase/app';
import {
  doc,
  getDocFromServer,
  initializeFirestore,
  memoryLocalCache,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Replace Firebase's lazy heartbeat service with a memory-only no-op so it never
// opens `firebase-heartbeat-database` in IndexedDB (zero browser storage policy).
const heartbeatComponent = (
  app as unknown as {
    container?: {
      getProvider?: (name: string) => {
        getComponent?: () => { instanceFactory?: () => unknown } | null;
      };
    };
  }
).container?.getProvider?.('heartbeat')?.getComponent?.();
if (heartbeatComponent) {
  heartbeatComponent.instanceFactory = () => ({
    triggerHeartbeat: async () => undefined,
    getHeartbeatsHeader: async () => '',
  });
}

// Use memory-only cache (no IndexedDB, no localStorage, no cookies)
export const db = initializeFirestore(
  app,
  { localCache: memoryLocalCache() },
  firebaseConfig.firestoreDatabaseId,
);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();
