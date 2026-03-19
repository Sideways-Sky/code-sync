import { DbConnection } from '../module_bindings'

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
