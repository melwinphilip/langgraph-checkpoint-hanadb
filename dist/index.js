import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { hanaClient } from "@sap/hana-client";

/**
 * A LangGraph checkpoint saver backed by an HANA database.
 */
export class HANADBCheckpointSaver extends BaseCheckpointSaver {
    constructor({ client, dbName, checkpointTableName, checkpointWritesTableName }, serde) {
        super(serde);
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "db", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "checkpointTableName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "CHECKPOINTS"
        });
        Object.defineProperty(this, "checkpointWritesTableName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "CHECKPOINT_WRITES"
        });
        this.client = client;
        //this.db = this.client.connect(dbName); - Commented - MEL
        this.db = client; //MEL
        this.checkpointTableName =
            checkpointTableName ?? this.checkpointTableName;
        this.checkpointWritesTableName =
            checkpointWritesTableName ?? this.checkpointWritesTableName;
        this.ensureTablesExist().catch(console.error);
    }

    async ensureTablesExist() {
        const createCheckpointsTableQuery = `
            CREATE OR REPLACE PROCEDURE createCheckpointsTableQueryPROC AS 
            BEGIN
                IF NOT EXISTS (SELECT * FROM SYS.TABLES WHERE table_name = '${this.checkpointWritesTableName}') THEN
            CREATE TABLE ${this.checkpointTableName} (
                thread_id NVARCHAR(255),
                checkpoint_ns NVARCHAR(255),
                checkpoint_id NVARCHAR(255),
                parent_checkpoint_id NVARCHAR(255),
                type NVARCHAR(255),
                checkpoint CLOB,
                metadata CLOB,
                PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
            );
            END IF;
          END;
        `;
        const createCheckpointWritesTableQuery = `
        CREATE OR REPLACE PROCEDURE createCheckpointWritesTableQueryPROC AS 
            BEGIN
                IF NOT EXISTS (SELECT * FROM SYS.TABLES WHERE table_name = '${this.createCheckpointWritesTableQuery}') THEN
            CREATE TABLE IF NOT EXISTS ${this.checkpointWritesTableName} (
                thread_id NVARCHAR(255),
                checkpoint_ns NVARCHAR(255),
                checkpoint_id NVARCHAR(255),
                task_id NVARCHAR(255),
                idx INT,
                channel NVARCHAR(255),
                type NVARCHAR(255),
                value CLOB,
                PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
           );
            END IF;
          END;
        `;
        await this.db.exec(createCheckpointsTableQuery);
        await this.db.exec('CALL createCheckpointsTableQueryPROC;');
        await this.db.exec(createCheckpointWritesTableQuery);
        await this.db.exec('CALL createCheckpointWritesTableQueryPROC;');
    }
    /**
     * Retrieves a checkpoint from the HANA database based on the
     * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
     * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
     * for the given thread ID is retrieved.
     */
    async getTuple(config) {
        const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
        let query;
        const params = [thread_id, checkpoint_ns];
        if (checkpoint_id) {
            query = `SELECT * FROM ${this.checkpointTableName} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY checkpoint_id DESC LIMIT 1`;
            params.push(checkpoint_id);
        } else {
            query = `SELECT * FROM ${this.checkpointTableName} WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`;
        }
        const result = await this.db.exec(query, params);
        if (result.length === 0) {
            return undefined;
        }
        const doc = result[0];
        const configurableValues = {
            thread_id,
            checkpoint_ns,
            checkpoint_id: doc.CHECKPOINT_ID,
        };
        const checkpoint = await this.serde.loadsTyped(doc.TYPE, doc.CHECKPOINT);
        const serializedWrites = await this.db.exec(
            `SELECT * FROM ${this.checkpointWritesTableName} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
            [thread_id, checkpoint_ns, doc.CHECKPOINT_ID]
        );
        const pendingWrites = await Promise.all(serializedWrites.map(async (serializedWrite) => {
            return [
                serializedWrite.TASK_ID,
                serializedWrite.CHANNEL,
                await this.serde.loadsTyped(serializedWrite.TYPE, serializedWrite.VALUE),
            ];
        }));
        return {
            config: { configurable: configurableValues },
            checkpoint,
            pendingWrites,
            metadata: await this.serde.loadsTyped(doc.TYPE, doc.METADATA),
            parentConfig: doc.PARENT_CHECKPOINT_ID != null
                ? {
                    configurable: {
                        thread_id,
                        checkpoint_ns,
                        checkpoint_id: doc.PARENT_CHECKPOINT_ID,
                    },
                }
                : undefined,
        };
    }

    /**
     * Retrieve a list of checkpoint tuples from the HANA database based
     * on the provided config. The checkpoints are ordered by checkpoint ID
     * in descending order (newest first).
     */
    async *list(config, options) {
        const { limit, before, filter } = options ?? {};
        let query = `SELECT * FROM ${this.checkpointTableName} WHERE 1=1`;
        const params = [];

        if (config?.configurable?.thread_id) {
            query += ` AND thread_id = ?`;
            params.push(config.configurable.thread_id);
        }
        if (config?.configurable?.checkpoint_ns !== undefined &&
            config?.configurable?.checkpoint_ns !== null) {
            query += ` AND checkpoint_ns = ?`;
            params.push(config.configurable.checkpoint_ns);
        }
        if (filter) {
            Object.entries(filter).forEach(([key, value]) => {
                query += ` AND ${key} = ?`;
                params.push(value);
            });
        }
        if (before) {
            query += ` AND checkpoint_id < ?`;
            params.push(before);
        }
        query += ` ORDER BY checkpoint_id DESC`;
        if (limit) {
            query += ` LIMIT ?`;
            params.push(limit);
        }

        const result = await this.db.exec(query, params);
        for (const row of result) {
            yield {
                config: { configurable: configurableValues },
                checkpoint: row.CHECKPOINT,
                pendingWrites: row.PENDING_WRITES,
                metadata: await this.serde.loadsTyped(row.TYPE, row.METADATA),
                parentConfig: row.PARENT_CHECKPOINT_ID != null
                    ? {
                        configurable: {
                            thread_id: row.THREAD_ID,
                            checkpoint_ns: row.CHECKPOINT_NS,
                            checkpoint_id: row.PARENT_CHECKPOINT_ID,
                        },
                    }
                    : undefined,
            };
        }
    }

    /**
     * Saves a checkpoint to the HANA database. The checkpoint is associated
     * with the provided config and its parent config (if any).
     */
    async put(config, checkpoint, metadata) {
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
        const checkpoint_id = checkpoint.id;
        if (thread_id === undefined) {
            throw new Error(`The provided config must contain a configurable field with a "thread_id" field.`);
        }
        const [checkpointType, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
        const [metadataType, serializedMetadata] = this.serde.dumpsTyped(metadata);
        if (checkpointType !== metadataType) {
            throw new Error("Mismatched checkpoint and metadata types.");
        }
        const query = `UPSERT ${this.checkpointTableName} VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [
            thread_id,
            checkpoint_ns,
            checkpoint_id,
            config.configurable?.checkpoint_id,
            checkpointType,
            serializedCheckpoint,
            serializedMetadata
        ];
        await this.db.exec(query, params);
        return {
            configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id,
            },
        };
    }

    /**
     * Saves intermediate writes associated with a checkpoint to the HANA database.
     */
    async putWrites(config, writes, taskId) {
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns;
        const checkpoint_id = config.configurable?.checkpoint_id;
        if (thread_id === undefined ||
            checkpoint_ns === undefined ||
            checkpoint_id === undefined) {
            throw new Error(`The provided config must contain a configurable field with "thread_id", "checkpoint_ns" and "checkpoint_id" fields.`);
        }
        const operations = writes.map(([channel, value], idx) => {
            const [type, serializedValue] = this.serde.dumpsTyped(value);
            const query = `UPSERT ${this.checkpointWritesTableName} VALUES (?, ?, ?, ?, ?, ?, ?)`;
            const params = [
                thread_id,
                checkpoint_ns,
                checkpoint_id,
                taskId,
                idx,
                channel,
                type,
                serializedValue
            ];
            return this.db.exec(query, params);
        });
        await Promise.all(operations);
    }
}
