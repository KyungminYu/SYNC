export const repoRoot: string;
export function databaseConfig(mode?: string): {
  uri: string;
  httpUri: string;
  database: string;
};
