import type { Client } from '@libsql/client'
import { createClient } from '@libsql/client'
import { loggerService } from '@logger'
import type { KnowledgeItemType } from '@types'

const logger = loggerService.withContext('KnowledgeDocumentStore')

export type KnowledgeDocument = {
  uniqueId: string
  type: KnowledgeItemType
  source: string
  displayName?: string
  content: string
  updatedAt: number
}

/**
 * Stores full extracted document contents for a knowledge base.
 *
 * Rationale:
 * - The vector table stores chunked `pageContent` with a UNIQUE constraint, which is not reliable to reconstruct
 *   full documents (duplicates can be dropped).
 * - This table persists full contents so "Full files" mode can reuse extracted text without re-parsing files.
 */
export class KnowledgeDocumentStore {
  private readonly client: Client
  private initialized = false
  private readonly tableName = 'knowledge_documents'

  constructor(dbPath: string) {
    this.client = createClient({ url: `file:${dbPath}` })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return

    await this.client.execute(`CREATE TABLE IF NOT EXISTS ${this.tableName} (
      uniqueId    TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      source      TEXT NOT NULL,
      displayName TEXT,
      content     TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL
    );`)

    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_${this.tableName}_type ON ${this.tableName} (type);`)
    await this.client.execute(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_updatedAt ON ${this.tableName} (updatedAt);`
    )

    this.initialized = true
  }

  async upsert(doc: KnowledgeDocument): Promise<void> {
    await this.ensureInitialized()
    try {
      await this.client.execute({
        sql: `INSERT INTO ${this.tableName} (uniqueId, type, source, displayName, content, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(uniqueId) DO UPDATE SET
                type = excluded.type,
                source = excluded.source,
                displayName = excluded.displayName,
                content = excluded.content,
                updatedAt = excluded.updatedAt;`,
        args: [doc.uniqueId, doc.type, doc.source, doc.displayName ?? null, doc.content, doc.updatedAt]
      })
    } catch (err) {
      logger.error('Failed to upsert knowledge document', { uniqueId: doc.uniqueId, err })
      throw err
    }
  }

  async getByUniqueIds(uniqueIds: string[]): Promise<KnowledgeDocument[]> {
    await this.ensureInitialized()
    if (uniqueIds.length === 0) return []

    const placeholders = uniqueIds.map(() => '?').join(',')
    const result = await this.client.execute({
      sql: `SELECT uniqueId, type, source, displayName, content, updatedAt
            FROM ${this.tableName}
            WHERE uniqueId IN (${placeholders});`,
      args: uniqueIds
    })

    const docs: KnowledgeDocument[] = []
    for (const row of result.rows) {
      const uniqueId = row.uniqueId?.toString()
      const type = row.type?.toString()
      const source = row.source?.toString()
      const content = row.content?.toString()
      const updatedAt = row.updatedAt !== null && row.updatedAt !== undefined ? Number(row.updatedAt) : NaN

      if (!uniqueId || !type || !source || !content || Number.isNaN(updatedAt)) {
        continue
      }

      docs.push({
        uniqueId,
        type: type as KnowledgeItemType,
        source,
        displayName: row.displayName ? row.displayName.toString() : undefined,
        content,
        updatedAt
      })
    }
    return docs
  }

  async deleteByUniqueIds(uniqueIds: string[]): Promise<void> {
    await this.ensureInitialized()
    if (uniqueIds.length === 0) return

    const placeholders = uniqueIds.map(() => '?').join(',')
    await this.client.execute({
      sql: `DELETE FROM ${this.tableName} WHERE uniqueId IN (${placeholders});`,
      args: uniqueIds
    })
  }

  async reset(): Promise<void> {
    await this.ensureInitialized()
    await this.client.execute(`DELETE FROM ${this.tableName};`)
  }
}
