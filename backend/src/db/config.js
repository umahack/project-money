function parseDatabaseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new Error('TURSO_DATABASE_URL must be a valid libSQL or file URL.');
  }
}

/**
 * Read and validate database configuration before a client is created.
 * Test processes are deliberately limited to local file-backed databases and
 * cannot carry a Turso authentication token.
 */
export function readDatabaseConfig(environment = process.env) {
  const url = environment.TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TURSO_DATABASE_URL not set. See README for setup.');
  }

  const parsedUrl = parseDatabaseUrl(url);
  const authToken = environment.TURSO_AUTH_TOKEN?.trim() || undefined;

  if (environment.NODE_ENV === 'test') {
    if (parsedUrl.protocol !== 'file:') {
      throw new Error('Tests require an isolated file: database URL; remote Turso URLs are refused.');
    }
    if (authToken) {
      throw new Error('Tests must not use TURSO_AUTH_TOKEN.');
    }
  }

  return { url, authToken };
}
