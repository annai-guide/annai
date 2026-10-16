/**
 * @typedef {'blobs'|'files'|'events'|'secrets'|'scopes'} StoreName
 * @typedef {{ hash: string, type: string, size: number, data: ArrayBuffer }} BlobRecord
 * @typedef {{ width?: number, height?: number, taken?: string, place?: { lat: number, lng: number }, original?: boolean }} PhotoMeta
 *   A photo's pixel size as stored, when it was taken (ISO 8601, with an offset when the photo
 *   records one) and where. original: the bytes are the photo as taken, embedded metadata included.
 * @typedef {{ scope: string, path: string, hash: string, size: number, type: string,
 *   author: string, source?: string, meta?: PhotoMeta, created: number, modified: number }} FileEntry
 * @typedef {{ scope: string, seq: number, ts: number, type: string, actor: string,
 *   data?: any, refs?: string[] }} EventRecord
 * @typedef {{ ts: number, type: string, actor: string, data?: any, refs?: string[] }} NewEvent
 * @typedef {{ id: string, kind: 'me'|'trip'|'sys', title: string, status: 'active'|'archived',
 *   created: number, updated: number, format: number, tripId?: string, backup?: { at: number, seq: number } }} ScopeRecord
 *   backup: the last saved Backup that held this trip: when, and the last history entry it holds (spec §4.9).
 * @typedef {{ after?: number, before?: number, limit?: number, reverse?: boolean, types?: string[] }} EventQuery
 *
 * @typedef {object} Tx
 * @property {(hash: string) => Promise<BlobRecord|undefined>} getBlob
 * @property {(hash: string) => Promise<boolean>} hasBlob
 * @property {(rec: BlobRecord) => Promise<void>} putBlob
 * @property {(hash: string) => Promise<void>} deleteBlob
 * @property {() => Promise<{ hash: string, size: number }[]>} listBlobs  every blob's hash and size, without reading its content
 * @property {(scope: string, path: string) => Promise<FileEntry|undefined>} getFile
 * @property {(entry: FileEntry) => Promise<void>} putFile
 * @property {(scope: string, path: string) => Promise<void>} deleteFile
 * @property {(scope: string, prefix?: string) => Promise<FileEntry[]>} listFiles  sorted by path
 * @property {(scope: string) => Promise<number>} lastSeq  0 when the scope has no events
 * @property {(scope: string, ev: NewEvent) => Promise<EventRecord>} appendEvent  assigns seq = lastSeq + 1
 * @property {(rec: EventRecord) => Promise<void>} putEvent  keeps rec.seq (used by import)
 * @property {(scope: string, q?: EventQuery) => Promise<EventRecord[]>} listEvents
 * @property {(id: string) => Promise<ScopeRecord|undefined>} getScope
 * @property {(rec: ScopeRecord) => Promise<void>} putScope
 * @property {() => Promise<ScopeRecord[]>} listScopes
 * @property {(id: string) => Promise<void>} deleteScope  removes the record, its files and its events (not blobs)
 * @property {(id: string) => Promise<any>} getSecret
 * @property {(id: string, value: any) => Promise<void>} putSecret
 * @property {(id: string) => Promise<void>} deleteSecret
 * @property {() => Promise<string[]>} listSecretIds
 *
 * @typedef {object} Store
 * @property {<T>(stores: StoreName[], mode: 'readonly'|'readwrite', fn: (tx: Tx) => Promise<T>) => Promise<T>} tx
 *   Runs fn in one transaction. A read-write transaction commits only if fn resolves.
 *   When the device is out of space it rejects with StorageFullError (errors.js) and writes nothing.
|'readwrite', fn: (tx: Tx) => Promise<T>) => Promise<T>} tx
 *   Runs fn in one transaction. A read-write transaction commits only if fn resolves.
 *   Inside fn, await only Tx calls: awaiting anything else lets IndexedDB commit early.
 * @property {() => void} close  stops the store for good: every later tx rejects with StoppedError (errors.js)
 */
export {};
