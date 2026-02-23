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
		docId: t.string().primaryKey(),
		/** Opaque Uint8Array — full Y.js snapshot produced by Y.encodeStateAsUpdate */
		snapshot: t.byteArray(),
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
		update: t.byteArray(),
		sender: t.identity(),
		createdAt: t.timestamp(),
	},
)

export const YjsAwareness = table(
	{
		name: 'yjs_awareness',
		public: true,
		indexes: [{ name: 'by_doc', algorithm: 'btree', columns: ['docId'] }],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		docId: t.string(),
		identity: t.identity(),
		state: t.string(),
		updatedAt: t.timestamp(),
	},
)

export const spacetimedb = schema(YjsDocument, YjsUpdate, YjsAwareness)
