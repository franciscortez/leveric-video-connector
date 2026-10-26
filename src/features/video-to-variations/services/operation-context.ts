import { AsyncLocalStorage } from "node:async_hooks";
type OperationContext = { owner: string; operationId?: string; kind?: string };
const shared = globalThis as typeof globalThis & { videoOperationContext?: AsyncLocalStorage<OperationContext>; videoWriters?: Map<string, { owner: string; count: number }> };
export const operationContext = shared.videoOperationContext ??= new AsyncLocalStorage<OperationContext>();
export const projectWriters = shared.videoWriters ??= new Map();
