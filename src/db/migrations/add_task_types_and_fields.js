const { Pool } = require('pg');
const config = require('../../config/config');

async function up() {
    const pool = new Pool(config.database);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // Create task_types table
        await client.query(`
            CREATE TABLE IF NOT EXISTS task_types (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT,
                status TEXT,
                orderindex INTEGER,
                workspace_id TEXT NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add task type columns to clickup_task
        await client.query(`
            ALTER TABLE clickup_task 
            ADD COLUMN IF NOT EXISTS task_type_id TEXT REFERENCES task_types(id),
            ADD COLUMN IF NOT EXISTS task_type_name TEXT;
        `);

        // Create indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_task_type_id ON clickup_task(task_type_id);
            CREATE INDEX IF NOT EXISTS idx_task_custom_fields ON clickup_task USING gin (custom_fields);
            CREATE INDEX IF NOT EXISTS idx_task_field_values ON clickup_task USING gin (field_values);
        `);

        // Create field mappings table
        await client.query(`
            CREATE TABLE IF NOT EXISTS custom_field_mappings (
                id SERIAL PRIMARY KEY,
                field_name TEXT NOT NULL,
                clickup_field_id TEXT NOT NULL,
                data_type TEXT NOT NULL,
                column_name TEXT,
                is_mapped BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(clickup_field_id)
            );
        `);

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

async function down() {
    const pool = new Pool(config.database);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // Drop indexes
        await client.query(`
            DROP INDEX IF EXISTS idx_task_type_id;
            DROP INDEX IF EXISTS idx_task_custom_fields;
            DROP INDEX IF EXISTS idx_task_field_values;
        `);

        // Remove task type columns
        await client.query(`
            ALTER TABLE clickup_task 
            DROP COLUMN IF EXISTS task_type_id,
            DROP COLUMN IF EXISTS task_type_name;
        `);

        // Drop tables
        await client.query(`
            DROP TABLE IF EXISTS custom_field_mappings;
            DROP TABLE IF EXISTS task_types;
        `);

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

module.exports = { up, down }; 