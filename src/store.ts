import sqlite3 from 'sqlite3';
import { promises as fs } from 'fs';
import path from 'path';
import { Chunk } from './chunker';

export interface StoredChunk {
  id: number;
  repo: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  createdAt: string;
}

export interface SearchResult {
  chunk: StoredChunk;
  similarity: number;
}

export class VectorStore {
  private db!: sqlite3.Database;
  private dbPath: string;

  getDatabase(): sqlite3.Database {
    return this.db;
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    await this.ensureDirectoryExists();
    
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(new Error(`Failed to open database: ${err.message}`));
        } else {
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  private async ensureDirectoryExists(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async createTables(): Promise<void> {
    const createChunksTable = `
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(repo, file_path, chunk_index)
      )
    `;

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_repo ON chunks(repo)',
      'CREATE INDEX IF NOT EXISTS idx_file_path ON chunks(file_path)',
      'CREATE INDEX IF NOT EXISTS idx_repo_file ON chunks(repo, file_path)'
    ];

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(createChunksTable, (err) => {
          if (err) {
            reject(new Error(`Failed to create chunks table: ${err.message}`));
            return;
          }

          let completed = 0;
          const total = createIndexes.length;

          createIndexes.forEach((indexSql) => {
            this.db.run(indexSql, (err) => {
              if (err) {
                reject(new Error(`Failed to create index: ${err.message}`));
                return;
              }
              
              completed++;
              if (completed === total) {
                resolve();
              }
            });
          });

          if (total === 0) {
            resolve();
          }
        });
      });
    });
  }

  async saveChunk(repo: string, chunk: Chunk, embedding: number[]): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO chunks (repo, file_path, chunk_index, text, embedding)
      VALUES (?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [
        repo,
        chunk.filePath,
        chunk.index,
        chunk.text,
        JSON.stringify(embedding)
      ], function(err) {
        if (err) {
          reject(new Error(`Failed to save chunk: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async saveChunks(repo: string, chunks: Chunk[], embeddings: number[][]): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error('Chunks and embeddings arrays must have the same length');
    }

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');

        const sql = `
          INSERT OR REPLACE INTO chunks (repo, file_path, chunk_index, text, embedding)
          VALUES (?, ?, ?, ?, ?)
        `;

        let completed = 0;
        let hasError = false;

        for (let i = 0; i < chunks.length; i++) {
          if (hasError) break;

          this.db.run(sql, [
            repo,
            chunks[i].filePath,
            chunks[i].index,
            chunks[i].text,
            JSON.stringify(embeddings[i])
          ], (err) => {
            if (err && !hasError) {
              hasError = true;
              this.db.run('ROLLBACK');
              reject(new Error(`Failed to save chunk ${i}: ${err.message}`));
              return;
            }

            completed++;
            if (completed === chunks.length && !hasError) {
              this.db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  reject(new Error(`Failed to commit transaction: ${commitErr.message}`));
                } else {
                  resolve();
                }
              });
            }
          });
        }
      });
    });
  }

  async searchSimilar(queryEmbedding: number[], topK: number = 5, repo?: string): Promise<SearchResult[]> {
    const BATCH_SIZE = 1000;
    let sql = 'SELECT id, repo, file_path, chunk_index, text, embedding, created_at FROM chunks';
    const params: any[] = [];

    if (repo) {
      sql += ' WHERE repo = ?';
      params.push(repo);
    }
    sql += ' ORDER BY id';

    return new Promise((resolve, reject) => {
      const results: SearchResult[] = [];
      let offset = 0;
      let hasMore = true;

      const processBatch = () => {
        const batchSql = sql + ` LIMIT ${BATCH_SIZE} OFFSET ${offset}`;
        
        this.db.all(batchSql, params, (err, rows: any[]) => {
          if (err) {
            reject(new Error(`Failed to search chunks: ${err.message}`));
            return;
          }

          if (rows.length === 0) {
            hasMore = false;
            results.sort((a, b) => b.similarity - a.similarity);
            resolve(results.slice(0, topK));
            return;
          }

          try {
            for (const row of rows) {
              const embedding = JSON.parse(row.embedding);
              const similarity = this.calculateCosineSimilarity(queryEmbedding, embedding);
              
              if (results.length < topK) {
                results.push({
                  chunk: {
                    id: row.id,
                    repo: row.repo,
                    filePath: row.file_path,
                    chunkIndex: row.chunk_index,
                    text: row.text,
                    embedding: embedding,
                    createdAt: row.created_at
                  },
                  similarity
                });
              } else {
                const minSimilarity = Math.min(...results.map(r => r.similarity));
                if (similarity > minSimilarity) {
                  const minIndex = results.findIndex(r => r.similarity === minSimilarity);
                  results[minIndex] = {
                    chunk: {
                      id: row.id,
                      repo: row.repo,
                      filePath: row.file_path,
                      chunkIndex: row.chunk_index,
                      text: row.text,
                      embedding: embedding,
                      createdAt: row.created_at
                    },
                    similarity
                  };
                }
              }
            }

            offset += BATCH_SIZE;
            if (hasMore && rows.length === BATCH_SIZE) {
              setImmediate(processBatch);
            } else {
              results.sort((a, b) => b.similarity - a.similarity);
              resolve(results.slice(0, topK));
            }
          } catch (parseErr) {
            reject(new Error(`Failed to parse search results: ${parseErr}`));
          }
        });
      };

      processBatch();
    });
  }

  private calculateCosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same dimension');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (norm1 * norm2);
  }

  async getChunksByRepo(repo: string): Promise<StoredChunk[]> {
    const sql = 'SELECT * FROM chunks WHERE repo = ? ORDER BY file_path, chunk_index';
    
    return new Promise((resolve, reject) => {
      this.db.all(sql, [repo], (err, rows: any[]) => {
        if (err) {
          reject(new Error(`Failed to get chunks: ${err.message}`));
          return;
        }

        try {
          const chunks = rows.map(row => ({
            id: row.id,
            repo: row.repo,
            filePath: row.file_path,
            chunkIndex: row.chunk_index,
            text: row.text,
            embedding: JSON.parse(row.embedding),
            createdAt: row.created_at
          }));
          
          resolve(chunks);
        } catch (parseErr) {
          reject(new Error(`Failed to parse chunks: ${parseErr}`));
        }
      });
    });
  }

  async deleteRepo(repo: string): Promise<void> {
    const sql = 'DELETE FROM chunks WHERE repo = ?';
    
    return new Promise((resolve, reject) => {
      this.db.run(sql, [repo], function(err) {
        if (err) {
          reject(new Error(`Failed to delete repo: ${err.message}`));
        } else {
          console.log(`Deleted ${this.changes} chunks for repo: ${repo}`);
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(new Error(`Failed to close database: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async getStats(): Promise<{ totalChunks: number; repoCount: number; repos: string[] }> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        let stats = { totalChunks: 0, repoCount: 0, repos: [] as string[] };
        let completed = 0;

        this.db.get('SELECT COUNT(*) as count FROM chunks', (err, row: any) => {
          if (err) {
            reject(err);
            return;
          }
          stats.totalChunks = row.count;
          completed++;
          if (completed === 2) resolve(stats);
        });

        this.db.all('SELECT DISTINCT repo FROM chunks ORDER BY repo', (err, rows: any[]) => {
          if (err) {
            reject(err);
            return;
          }
          stats.repos = rows.map(row => row.repo);
          stats.repoCount = stats.repos.length;
          completed++;
          if (completed === 2) resolve(stats);
        });
      });
    });
  }
}