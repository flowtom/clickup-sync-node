// Import required PostgreSQL client and configuration
const { Pool } = require('pg');
const config = require('../config/config');

// Create connection pool using database configuration
const pool = new Pool(config.postgres);

/**
 * Initializes database tables and adds custom field columns if they don't exist
 */
async function initializeTables() {
  const client = await pool.connect();
  try {
    // First check connection
    const connected = await checkConnection();
    if (!connected) {
      throw new Error('Could not establish database connection');
    }

    await client.query(`
      -- Core task table with all required fields from ClickUp
      CREATE TABLE IF NOT EXISTS clickup_task (
        id TEXT PRIMARY KEY,
        _airbyte_raw_id TEXT NOT NULL DEFAULT md5(random()::text),
        _airbyte_extracted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        name TEXT,
        text_content TEXT,
        description TEXT,
        status TEXT,
        date_created TIMESTAMP WITH TIME ZONE,
        date_updated TIMESTAMP WITH TIME ZONE,
        date_closed TIMESTAMP WITH TIME ZONE,
        creator JSONB,
        assignees JSONB,
        checklists JSONB,
        tags JSONB,
        parent JSONB,
        priority JSONB,
        due_date TIMESTAMP WITH TIME ZONE,
        start_date TIMESTAMP WITH TIME ZONE,
        points INTEGER,
        time_estimate INTEGER,
        time_spent INTEGER,
        custom_fields JSONB DEFAULT '{}'::jsonb,
        relationships JSONB DEFAULT '{}'::jsonb,
        field_values JSONB DEFAULT '{}'::jsonb,
        custom_type JSONB,
        list JSONB,
        folder JSONB,
        space JSONB,
        url TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Add indexes
      CREATE INDEX IF NOT EXISTS idx_task_custom_fields ON clickup_task USING gin (custom_fields);
      CREATE INDEX IF NOT EXISTS idx_task_field_values ON clickup_task USING gin (field_values);
      CREATE INDEX IF NOT EXISTS idx_task_updated_at ON clickup_task(updated_at);
    `);

    console.log('Database tables initialized with ClickUp schema');
  } finally {
    client.release();
  }
}

/**
 * Updates a task's field value and records the change
 */
async function updateTaskField(taskId, fieldName, newValue, client) {
  // Get current value
  const currentResult = await client.query(
    'SELECT * FROM clickup_task WHERE id = $1',
    [taskId]
  );
  
  const currentValue = currentResult.rows[0]?.[fieldName];
  
  // Only record change if value is different
  if (JSON.stringify(currentValue) !== JSON.stringify(newValue)) {
    // Record the change
    await client.query(
      `INSERT INTO field_changes (task_id, field_name, old_value, new_value)
       VALUES ($1, $2, $3, $4)`,
      [taskId, fieldName, JSON.stringify(currentValue), JSON.stringify(newValue)]
    );

    // Update the current value
    await client.query(
      `UPDATE clickup_task 
       SET ${fieldName} = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [newValue, taskId]
    );
  }
}

/**
 * Checks if a task exists in the database
 * @param {string} taskId - ID of the task to check
 * @returns {Promise<boolean>} Whether the task exists
 */
async function checkTaskExists(taskId) {
  const result = await pool.query(
    'SELECT EXISTS(SELECT 1 FROM clickup_task WHERE id = $1)',
    [taskId]
  );
  return result.rows[0].exists;
}

/**
 * Updates task custom fields and relationships
 * @param {string} taskId - ID of the task
 * @param {Object} fieldData - Structured field data
 * @param {Object} fieldData.customFields - Field definitions/metadata
 * @param {Object} fieldData.relationships - Parent/child relationships
 * @param {Object} fieldData.fieldValues - Actual field values
 */
async function updateTaskCustomFields(taskId, fieldData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('[DB] Updating task with data:', {
      taskId,
      customFieldsCount: Object.keys(fieldData.customFields || {}).length,
      relationshipsCount: Object.keys(fieldData.relationships || {}).length,
      fieldValuesCount: Object.keys(fieldData.fieldValues || {}).length
    });

    // Update existing task with ALL fields
    const query = `
      UPDATE clickup_task 
      SET 
        custom_fields = $2,
        relationships = $3,
        field_values = $4,
        status = COALESCE($5, status),
        name = COALESCE($6, name),
        description = COALESCE($7, description),
        date_updated = CURRENT_TIMESTAMP,
        _airbyte_extracted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const result = await client.query(query, [
      taskId,
      JSON.stringify(fieldData.customFields || {}),
      JSON.stringify(fieldData.relationships || {}),
      JSON.stringify(fieldData.fieldValues || {}),
      fieldData.status,
      fieldData.name,
      fieldData.description
    ]);

    if (result.rowCount === 0) {
      console.error('[DB] No rows were updated for task:', taskId);
      await client.query('ROLLBACK');
      return null;
    }

    console.log('[DB] Successfully updated task:', {
      taskId,
      name: result.rows[0].name,
      status: result.rows[0].status,
      updatedAt: result.rows[0].updated_at
    });

    await client.query('COMMIT');
    return result.rows[0];

  } catch (error) {
    console.error('[DB] Error updating task:', {
      taskId,
      error: error.message,
      detail: error.detail,
      code: error.code
    });
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Updates task relationships
 * @param {string} taskId - ID of the task
 * @param {Object} relationships - Relationship data
 * @returns {Promise<Object|null>} Updated task or null if task not found
 */
async function updateTaskRelationships(taskId, relationships) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First verify the task exists
    const taskExists = await client.query(
      'SELECT 1 FROM clickup_task WHERE id = $1',
      [taskId]
    );

    if (taskExists.rowCount === 0) {
      console.warn(`Task ${taskId} not found, skipping relationship update`);
      await client.query('ROLLBACK');
      return null;
    }

    // Then verify the parent task exists if provided
    if (relationships.parent_id) {
      const parentExists = await client.query(
        'SELECT 1 FROM clickup_task WHERE id = $1',
        [relationships.parent_id]
      );

      if (parentExists.rowCount === 0) {
        console.warn(`Parent task ${relationships.parent_id} not found, skipping relationship`);
        relationships.parent_id = null;
      }
    }

    const query = `
      UPDATE clickup_task 
      SET parent_id = $2,
          task_type_id = (
            SELECT id FROM task_types 
            WHERE name = $3
            LIMIT 1
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const result = await client.query(query, [
      taskId,
      relationships.parent_id,
      relationships.custom_type
    ]);

    await client.query('COMMIT');
    return result.rows[0];

  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') { // Foreign key violation
      console.error(`Invalid relationship for task ${taskId}:`, error.detail);
      return null;
    }
    console.error(`Database error updating relationships for task ${taskId}:`, error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes old data from the database that is older than the specified retention period
 * @param {number} daysToKeep - Number of days of data to retain (default 90)
 * @returns {Promise<boolean>} Success status
 */
async function cleanOldData(daysToKeep = 90) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean old task data
    const deletedTasks = await client.query(`
      DELETE FROM clickup_task
      WHERE updated_at < NOW() - INTERVAL '${daysToKeep} days'
      RETURNING id
    `);

    // Clean orphaned task types
    const deletedTypes = await client.query(`
      DELETE FROM task_types
      WHERE id NOT IN (
        SELECT DISTINCT task_type_id 
        FROM clickup_task 
        WHERE task_type_id IS NOT NULL
      )
      RETURNING id
    `);

    await client.query('COMMIT');
    
    console.log(`Cleaned up ${deletedTasks.rowCount} old tasks and ${deletedTypes.rowCount} unused task types`);
    return true;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during data cleanup:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retrieves tasks that have had changes in the last X minutes
 * @param {number} minutes - Time window to check for changes (default 60)
 * @returns {Promise<Array>} List of recently changed tasks
 */
async function getRecentChanges(minutes = 60) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT 
        id,
        custom_fields,
        field_values,
        relationships,
        updated_at,
        _airbyte_extracted_at
      FROM clickup_task 
      WHERE updated_at >= NOW() - INTERVAL '${minutes} minutes'
      ORDER BY updated_at DESC
    `;
    const result = await client.query(query);
    console.log(`Found ${result.rowCount} changes in last ${minutes} minutes`);
    return result.rows;
  } catch (error) {
    console.error('Error getting recent changes:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Finds tasks that have a specific value for a given field
 * @param {string} fieldName - Name of the field to search
 * @param {any} value - Value to match
 * @returns {Array} Matching tasks
 */
async function findTasksByFieldValue(fieldName, value) {
  const query = `
    SELECT id, custom_field_values
    FROM tasks
    WHERE custom_field_values->>$1 IS NOT NULL
    AND custom_field_values->$1->>'value' = $2
  `;
  const result = await pool.query(query, [fieldName, JSON.stringify(value)]);
  return result.rows;
}

/**
 * Gets a summary of all values for a specific field across all tasks
 * @param {string} fieldName - Name of the field to summarize
 * @returns {Array} Summary statistics for the field
 */
async function getFieldValueSummary(fieldName) {
  const query = `
    SELECT 
      custom_field_values->$1->>'value' as field_value,
      COUNT(*) as count,
      MIN((custom_field_values->$1->>'updated_at')::timestamptz) as earliest_update,
      MAX((custom_field_values->$1->>'updated_at')::timestamptz) as latest_update
    FROM tasks
    WHERE custom_field_values ? $1
    GROUP BY custom_field_values->$1->>'value'
    ORDER BY count DESC
  `;
  const result = await pool.query(query, [fieldName]);
  return result.rows;
}

/**
 * Finds tasks by matching a core field value
 * @param {string} field - Name of the core field
 * @param {any} value - Value to match
 * @returns {Array} Matching tasks
 */
async function findTasksByCore(field, value) {
  const query = `
    SELECT *
    FROM clickup_task
    WHERE ${field} = $1
  `;
  const result = await pool.query(query, [value]);
  return result.rows;
}

/**
 * Gets a summary of values for a core field
 * @param {string} field - Name of the core field
 * @returns {Array} Summary statistics for the field
 */
async function getCoreFieldSummary(field) {
  const query = `
    SELECT ${field}, COUNT(*) as count
    FROM clickup_task
    WHERE ${field} IS NOT NULL
    GROUP BY ${field}
    ORDER BY count DESC
  `;
  const result = await pool.query(query);
  return result.rows;
}

/**
 * Gets the database structure for the clickup_task table
 * @returns {Array} Table column definitions
 */
async function getTableStructure() {
  const query = `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'clickup_task'
    ORDER BY ordinal_position;
  `;
  
  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error getting table structure:', error);
    throw error;
  }
}

/**
 * Retrieves a task by its ID
 * @param {string} taskId - ID of the task to retrieve
 * @returns {Object} Task record
 */
async function getTaskById(taskId) {
  console.log(`[DB] Getting task details for ${taskId}`);
  try {
    const result = await pool.query(
      'SELECT * FROM clickup_task WHERE id = $1',
      [taskId]
    );
    console.log(`[DB] Query result:`, {
      rowCount: result.rowCount,
      firstRow: result.rows[0] ? 'found' : 'null'
    });
    return result.rows[0] || null;
  } catch (error) {
    console.error(`[DB] Error getting task:`, error);
    throw error;
  }
}

/**
 * Gets all task types
 * @returns {Promise<Array>} List of task types
 */
async function getTaskTypes() {
  const query = `
    SELECT *
    FROM task_types
    ORDER BY orderindex ASC
  `;
  const result = await pool.query(query);
  return result.rows;
}

/**
 * Gets a task type by ID
 * @param {string} typeId - ID of the task type
 * @returns {Promise<Object|null>} Task type or null if not found
 */
async function getTaskTypeById(typeId) {
  const query = `
    SELECT *
    FROM task_types
    WHERE id = $1
  `;
  const result = await pool.query(query, [typeId]);
  return result.rows[0] || null;
}

/**
 * Gets the change history for a field with rich metadata
 * @param {string} taskId - ID of the task
 * @param {string} fieldName - Name of the field to track
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Change history records
 */
async function getFieldChangeHistory(taskId, fieldName, options = {}) {
  const {
    limit = 100,
    since = null,
    includeTaskDetails = false
  } = options;

  const params = [taskId, fieldName];
  let query = `
    WITH changes AS (
      SELECT 
        field_changes.id,
        field_changes.task_id,
        field_changes.field_name,
        field_changes.old_value,
        field_changes.new_value,
        field_changes.changed_at,
        LAG(new_value) OVER (
          PARTITION BY task_id, field_name 
          ORDER BY changed_at
        ) as previous_value,
        LEAD(new_value) OVER (
          PARTITION BY task_id, field_name 
          ORDER BY changed_at
        ) as next_value,
        ROW_NUMBER() OVER (
          PARTITION BY task_id, field_name 
          ORDER BY changed_at DESC
        ) as change_number
    `;

  if (includeTaskDetails) {
    query += `,
      COALESCE(t.name, '') as task_name,
      COALESCE(t.url, '') as task_url,
      COALESCE(t.status->>'status', '') as task_status
    FROM field_changes
    LEFT JOIN clickup_task t ON t.id = field_changes.task_id
    `;
  } else {
    query += `
    FROM field_changes
    `;
  }

  query += `
    WHERE task_id = $1 
    AND field_name = $2
  `;

  if (since) {
    query += ` AND changed_at >= $3`;
    params.push(since);
  }

  query += `) 
    SELECT * FROM changes 
    WHERE change_number <= $${params.length + 1}
    ORDER BY changed_at DESC
  `;
  
  params.push(limit);

  try {
    const result = await pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      duration: row.next_value ? 
        new Date(row.changed_at) - new Date(row.next_value.changed_at) : 
        null
    }));
  } catch (error) {
    console.error('Error getting field change history:', error);
    throw error;
  }
}

/**
 * Gets a summary of field changes across all tasks
 * @param {string} fieldName - Name of the field to analyze
 * @returns {Promise<Object>} Change statistics
 */
async function getFieldChangeStats(fieldName) {
  const query = `
    WITH field_stats AS (
      SELECT 
        task_id,
        COUNT(*) as change_count,
        MIN(changed_at) as first_change,
        MAX(changed_at) as last_change,
        array_agg(DISTINCT new_value) as unique_values
      FROM field_changes
      WHERE field_name = $1
      GROUP BY task_id
    )
    SELECT 
      COUNT(DISTINCT task_id) as tasks_with_changes,
      AVG(change_count)::numeric(10,2) as avg_changes_per_task,
      MAX(change_count) as max_changes_for_task,
      MIN(first_change) as earliest_change,
      MAX(last_change) as latest_change,
      COUNT(DISTINCT jsonb_array_elements_text(unique_values)) as unique_value_count
    FROM field_stats
  `;

  try {
    const result = await pool.query(query, [fieldName]);
    return result.rows[0];
  } catch (error) {
    console.error('Error getting field change stats:', error);
    throw error;
  }
}

/**
 * Execute a raw query
 * @param {string} text - Query text
 * @param {Array} params - Query parameters
 */
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Add this function to check database connectivity
async function checkConnection() {
  try {
    await pool.query('SELECT 1');
    console.log('Successfully connected to database');
    return true;
  } catch (error) {
    console.error('Database connection error:', error);
    return false;
  }
}

// Export all database functions
module.exports = {
  pool,
  query,
  initializeTables,
  cleanOldData,
  getRecentChanges,
  findTasksByCore,
  getCoreFieldSummary,
  getTableStructure,
  getTaskById,
  getTaskTypes,
  getTaskTypeById,
  updateTaskCustomFields,
  updateTaskRelationships,
  getFieldChangeHistory,
  getFieldChangeStats,
  checkTaskExists,
  checkConnection
}; 