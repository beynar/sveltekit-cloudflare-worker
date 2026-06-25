import path from 'node:path';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function serialize(value) {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (value instanceof RegExp) return value.toString();
	if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.entries(value)
			.map(([key, nestedValue]) => `${toJsString(key)}:${serialize(nestedValue)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

/**
 * @param {string} value
 */
export function toJsString(value) {
	return JSON.stringify(value);
}

/**
 * @param {string} from
 * @param {string} to
 */
export function toImportPath(from, to) {
	let relativePath = toPosix(path.relative(from, to));
	if (!relativePath.startsWith('.')) relativePath = './' + relativePath;
	return relativePath;
}

/**
 * @param {string} value
 */
export function toFsPath(value) {
	const normalized = toPosix(value);
	return `/@fs${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

/**
 * @param {string} id
 */
export function toViteImport(id) {
	if (path.isAbsolute(id)) return toFsPath(id);
	if (id.startsWith('..')) return toFsPath(path.posix.resolve(id));
	return '/' + toPosix(id);
}

/**
 * @param {string} value
 */
export function toPosix(value) {
	return value.replace(/\\/g, '/');
}
