/** Design 03. One database per project; `PRAGMA user_version` is the schema version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE project (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, entry TEXT NOT NULL CHECK (entry IN ('idea', 'novel', 'script')),
    style TEXT NOT NULL, genre TEXT NOT NULL, seconds_min INTEGER NOT NULL, seconds_max INTEGER NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('720p', '1080p')), created_at TEXT NOT NULL
  );
  CREATE TABLE episode (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), number INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, number));
  CREATE TABLE entity (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id),
    kind TEXT NOT NULL CHECK (kind IN ('character', 'location', 'prop')), name TEXT NOT NULL,
    first_episode_id INTEGER NOT NULL REFERENCES episode(id), UNIQUE (project_id, kind, name)
  );
  CREATE TABLE media (
    id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, path TEXT NOT NULL, mime TEXT NOT NULL,
    width INTEGER, height INTEGER, duration_s REAL, frames INTEGER, has_audio INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE node_run (
    id INTEGER PRIMARY KEY, node TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_review', 'done', 'failed')),
    attempt INTEGER NOT NULL DEFAULT 1, error TEXT, started_at TEXT, ended_at TEXT
  );
  CREATE TABLE artifact (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), kind TEXT NOT NULL, scope TEXT NOT NULL,
    version INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft', 'locked', 'stale', 'superseded', 'failed')),
    payload TEXT NOT NULL, media_id INTEGER REFERENCES media(id), input_digest TEXT NOT NULL, prompt_version TEXT,
    node_run_id INTEGER REFERENCES node_run(id), created_by TEXT NOT NULL CHECK (created_by IN ('model', 'user', 'program')),
    created_at TEXT NOT NULL, UNIQUE (kind, scope, version)
  );
  CREATE INDEX artifact_scope ON artifact (kind, scope, status);
  CREATE TABLE edge (from_id INTEGER NOT NULL REFERENCES artifact(id), to_id INTEGER NOT NULL REFERENCES artifact(id), PRIMARY KEY (from_id, to_id));
  CREATE INDEX edge_from ON edge (from_id);
  CREATE TABLE llm_call (
    id INTEGER PRIMARY KEY, node_run_id INTEGER REFERENCES node_run(id), task TEXT NOT NULL, model TEXT NOT NULL,
    prompt_version TEXT NOT NULL, system_text TEXT NOT NULL, user_text TEXT NOT NULL, response_text TEXT,
    tokens_in INTEGER, tokens_out INTEGER, ms INTEGER, ok INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE job (
    id INTEGER PRIMARY KEY, node_run_id INTEGER REFERENCES node_run(id), kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    provider TEXT NOT NULL CHECK (provider IN ('yir', 'comfyui')), request TEXT NOT NULL, request_hash TEXT NOT NULL,
    idempotency_key TEXT, status TEXT NOT NULL CHECK (status IN ('queued', 'submitting', 'submitted', 'unknown', 'downloading', 'succeeded', 'failed')),
    provider_job_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error TEXT, cost REAL, gpu_seconds REAL,
    output_media_id INTEGER REFERENCES media(id), created_at TEXT NOT NULL, submitted_at TEXT, finished_at TEXT
  );
  CREATE INDEX job_request ON job (request_hash, status);
  CREATE TABLE review (
    id INTEGER PRIMARY KEY, point INTEGER NOT NULL CHECK (point BETWEEN 1 AND 9), scope TEXT NOT NULL,
    artifact_ids TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open', 'closed')), opened_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE TABLE decision (
    id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES review(id),
    action TEXT NOT NULL CHECK (action IN ('approve', 'pick', 'revise', 'redo')), artifact_id INTEGER REFERENCES artifact(id),
    utterance TEXT, instruction TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE permit (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, pool TEXT NOT NULL CHECK (pool IN ('image', 'video')),
    count INTEGER NOT NULL CHECK (count > 0), used INTEGER NOT NULL DEFAULT 0, granted_at TEXT NOT NULL
  );
  `,
  // A revise or redo carries the creator's instruction and the version it starts from into the rerun.
  `
  ALTER TABLE node_run ADD COLUMN instruction TEXT;
  ALTER TABLE node_run ADD COLUMN previous_id INTEGER REFERENCES artifact(id);
  CREATE INDEX node_run_scope ON node_run (node, scope, status);
  CREATE INDEX job_node_run ON job (node_run_id);
  `,
  // What an artifact was before it went stale, so an upstream change that turns out to touch nothing can be undone.
  `
  ALTER TABLE artifact ADD COLUMN stale_from TEXT;
  `,
]
