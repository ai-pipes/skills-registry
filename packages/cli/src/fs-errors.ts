/** The error of a file system call on a path that does not exist. */
export const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
