import { DbConnection } from '../module_bindings'

export function uuidToU128(uuid: string): bigint {
	const hex = uuid.replace(/-/g, '')
	return BigInt('0x' + hex)
}

export function u128ToUuid(value: bigint): string {
	const hex = value.toString(16).padStart(32, '0')
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join('-')
}

let _conn: DbConnection
export function setConnection(conn: DbConnection) {
	if (!conn.isActive) {
		throw new Error('Connection is not active')
	} else if (!conn.identity) {
		throw new Error('Connection identity is not set')
	}
	_conn = conn
}
export function getConnection() {
	return _conn
}
