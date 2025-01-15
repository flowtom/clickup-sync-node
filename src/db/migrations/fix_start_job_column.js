const { pool } = require('../index');

async function migrateStartJobColumn() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create a temporary column
    await client.query(`
      ALTER TABLE clickup_task 
      ADD COLUMN IF NOT EXISTS start_job_new TIMESTAMP WITH TIME ZONE;
    `);

    // 2. Convert existing data
    await client.query(`
      UPDATE clickup_task
      SET start_job_new = 
        CASE 
          WHEN start_job IS NOT NULL AND start_job != ''
          THEN start_job::timestamp with time zone
          ELSE NULL
        END;
    `);

    // 3. Drop old column and rename new one
    await client.query(`
      ALTER TABLE clickup_task 
      DROP COLUMN start_job,
      ALTER COLUMN start_job_new RENAME TO start_job;
    `);

    // 4. Create indexes for commonly queried fields
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_task_start_job ON clickup_task (start_job);
      CREATE INDEX IF NOT EXISTS idx_task_client ON clickup_task (client);
      CREATE INDEX IF NOT EXISTS idx_task_job_name ON clickup_task (job_name);
    `);

    await client.query('COMMIT');
    console.log('Successfully migrated start_job column');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
migrateStartJobColumn().catch(console.error); 