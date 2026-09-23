import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROBOFLOW_DIR } from './constants.mjs';

export class RoboFlowDatabase {
    constructor(file = path.join(ROBOFLOW_DIR, 'roboflow.sqlite')) { this.file = file; }
    initialize() {
        if (this.db) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        if (fs.lstatSync(path.dirname(this.file)).isSymbolicLink() || (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())) throw new Error('Unsafe RoboFlow database path');
        this.db = new DatabaseSync(this.file);
        fs.chmodSync(this.file, 0o600);
        this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS workflow_types (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS task_instances (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), sequence INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(run_id, sequence));
            CREATE INDEX IF NOT EXISTS task_instances_run ON task_instances(run_id);`);
    }
    transaction(operation) {
        this.initialize();
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    close() { this.db?.close(); this.db = null; }
}
