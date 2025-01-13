import { type hanaClient } from "@sap/hana-client";
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, type Checkpoint, type CheckpointListOptions, type CheckpointTuple, type SerializerProtocol, type PendingWrite, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";

export type HANADBCheckpointSaverParams = {
    client: hanaClient;
    dbName?: string;
    checkpointTableName?: string;
    checkpointWritesTableName?: string;
};

/**
 * A LangGraph checkpoint saver backed by an HANA database.
 */
export declare class HANADBCheckpointSaver extends BaseCheckpointSaver {
    protected client: hanaClient;
    protected db: any;
    checkpointTableName: string;
    checkpointWritesTableName: string;
    constructor({ client, dbName, checkpointTableName, checkpointWritesTableName, }: HANADBCheckpointSaverParams, serde?: SerializerProtocol);
    
    /**
     * Ensures that the necessary tables exist in the HANA database.
     */
    ensureTablesExist(): Promise<void>;
    
    /**
     * Retrieves a checkpoint from the HANA database based on the
     * provided config. If the config contains a "checkpoint_id" key, the checkpoint with
     * the matching thread ID and checkpoint ID is retrieved. Otherwise, the latest checkpoint
     * for the given thread ID is retrieved.
     */
    getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>;

    /**
     * Retrieve a list of checkpoint tuples from the HANA database based
     * on the provided config. The checkpoints are ordered by checkpoint ID
     * in descending order (newest first).
     */
    list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>;

    /**
     * Saves a checkpoint to the HANA database. The checkpoint is associated
     * with the provided config and its parent config (if any).
     */
    put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig>;

    /**
     * Saves intermediate writes associated with a checkpoint to the HANA database.
     */
    putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void>;
}