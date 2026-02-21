import { schema, table, t } from 'spacetimedb/server'

// ---------------------------------------------------------------------------
// YjsDocument — one row per collaborative document
// ---------------------------------------------------------------------------
export const YjsDocument = table(
	{
		name: 'yjs_document',
		public: true,
		indexes: [],
	},
	{
		/** Stable string key chosen by the application (e.g. "file:/path/to/file") */
		docId: t.string().primaryKey(),
		/** Opaque Uint8Array — full Y.js snapshot produced by Y.encodeStateAsUpdate */
		snapshot: t.byteArray(),
		/** Logical clock: incremented on every compaction so clients can detect staleness */
		snapshotClock: t.u64(),
		updatedAt: t.timestamp(),
	},
)

// ---------------------------------------------------------------------------
// YjsUpdate — append-only delta log since last compaction checkpoint
// ---------------------------------------------------------------------------
export const YjsUpdate = table(
	{
		name: 'yjs_update',
		public: true,
		indexes: [{ name: 'by_doc', algorithm: 'btree', columns: ['docId'] }],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		docId: t.string(),
		/** Raw Y.js binary update (Y.encodeStateAsUpdate / mergeUpdates slice) */
		update: t.byteArray(),
		/** The snapshotClock of the checkpoint this delta is relative to */
		snapshotClock: t.u64(),
		sender: t.identity(),
		createdAt: t.timestamp(),
	},
)

// ---------------------------------------------------------------------------
// YjsAwareness — ephemeral per-user cursor / presence state
// Each user owns exactly one row per doc; row is upserted on every change.
// ---------------------------------------------------------------------------
export const YjsAwareness = table(
	{
		name: 'yjs_awareness',
		public: true,
		indexes: [{ name: 'by_doc', algorithm: 'btree', columns: ['docId'] }],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		docId: t.string(),
		clientId: t.u64(), // Yjs clientID (u32 in practice, safe as u64)
		identity: t.identity(),
		/** JSON-encoded awareness state from Y.awareness.getLocalState() */
		state: t.string(),
		updatedAt: t.timestamp(),
	},
)

export const spacetimedb = schema(YjsDocument, YjsUpdate, YjsAwareness)
