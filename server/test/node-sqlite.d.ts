// Runtime used by the tests is Node 24; the preinstalled Node typings predate SQLite.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: any[]): unknown;
      all(...params: any[]): unknown[];
      run(...params: any[]): {changes: number | bigint};
    };
    close(): void;
  }
}
