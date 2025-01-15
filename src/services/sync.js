// Import required dependencies
const db = require('../db');
const clickup = require('./clickup');
const config = require('../config/config');
const taskTypeSync = require('./taskTypeSync');

/**
 * Service class to handle synchronization between ClickUp and local database
 */
class SyncService {
  /**
   * Syncs custom fields from a ClickUp task to the local database
   * @param {string} taskId - ID of the task to sync
   */
  async syncTaskCustomFields(taskId) {
    try {
      console.log('\n=== Starting Task Sync ===');
      console.log(`[Sync] Task ID: ${taskId}`);

      // Get task details from ClickUp
      const taskDetails = await clickup.getTaskDetails(taskId);
      console.log('[Sync] ClickUp Response:', {
        taskFound: !!taskDetails,
        taskName: taskDetails?.name,
        customFieldCount: taskDetails?.custom_fields?.length || 0
      });
      
      if (!taskDetails) {
        console.warn('[Sync] No task details found in ClickUp');
        return { success: false, error: 'Task not found in ClickUp' };
      }

      // Check if task exists in database
      const taskExists = await db.checkTaskExists(taskId);
      console.log('[Sync] Task exists in DB:', taskExists);

      if (!taskExists) {
        console.log('[Sync] Creating new task record');
        try {
          const insertResult = await db.pool.query(`
            INSERT INTO clickup_task (
              id, 
              _airbyte_raw_id,
              _airbyte_extracted_at,
              name,
              text_content,
              description,
              status,
              date_created,
              date_updated,
              creator,
              custom_fields,
              relationships,
              field_values,
              custom_type,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
            RETURNING *
          `, [
            taskId,
            `manual_${taskId}`,
            new Date().toISOString(),
            taskDetails.name,
            taskDetails.text_content,
            taskDetails.description,
            taskDetails.status,
            taskDetails.date_created ? new Date(taskDetails.date_created) : null,
            taskDetails.date_updated ? new Date(taskDetails.date_updated) : null,
            JSON.stringify(taskDetails.creator || {}),
            JSON.stringify({}),
            JSON.stringify({}),
            JSON.stringify({}),
            JSON.stringify(taskDetails.custom_type || {})
          ]);
          console.log('[Sync] Insert successful:', {
            inserted: !!insertResult.rows[0],
            rowId: insertResult.rows[0]?.id,
            name: insertResult.rows[0]?.name
          });
        } catch (error) {
          console.error('[Sync] Insert failed:', {
            error: error.message,
            detail: error.detail,
            code: error.code
          });
          throw error;
        }
      }

      // Verify task exists after potential creation
      const verifyTask = await db.getTaskById(taskId);
      console.log('[Sync] Task verification:', {
        exists: !!verifyTask,
        id: verifyTask?.id
      });

      if (!verifyTask) {
        console.error('[Sync] Task still not found after creation attempt');
        return { success: false, error: 'Failed to create/find task' };
      }

      // First sync task types
      await taskTypeSync.syncTaskTypes();
      
      // Update task type relationship if present
      if (taskDetails.custom_type?.id) {
        await taskTypeSync.updateTaskTypeRelationships(
          taskId, 
          taskDetails.custom_type.id
        );
      }

      // Log custom fields received
      console.log('Custom fields received:', {
        taskId,
        fieldCount: taskDetails.custom_fields?.length || 0,
        fields: taskDetails.custom_fields?.map(f => ({
          name: f.name,
          type: f.type,
          hasValue: f.value !== null && f.value !== undefined
        }))
      });

      const fieldData = {
        customFields: {},
        relationships: {
          parent_id: taskDetails.parent,
          custom_type: taskDetails.custom_type?.name || null
        },
        fieldValues: {},
        name: taskDetails.name,
        status: taskDetails.status?.status || taskDetails.status,
        description: taskDetails.description
      };

      console.log('[Sync] Prepared field data:', {
        hasCustomFields: Object.keys(fieldData.customFields).length > 0,
        hasRelationships: !!fieldData.relationships.parent_id || !!fieldData.relationships.custom_type,
        hasFieldValues: Object.keys(fieldData.fieldValues).length > 0
      });

      // Process each field with validation
      if (Array.isArray(taskDetails.custom_fields)) {
        for (const field of taskDetails.custom_fields) {
          if (!field || !field.name) {
            console.warn(`Invalid field found in task ${taskId}:`, field);
            continue;
          }

          const cleanName = field.name.replace(/[\u{1F300}-\u{1F9FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();

          // Store field definition with validation
          fieldData.customFields[cleanName] = {
            id: field.id,
            type: field.type,
            config: field.type_config || {},
            original_name: field.name
          };

          // Only process fields with values
          if (field.value !== null && field.value !== undefined) {
            let normalizedValue = this.normalizeFieldValue(field);
            if (normalizedValue !== null) {
              const mappedField = this.mapFieldName(cleanName);
              if (mappedField) {
                fieldData.fieldValues[mappedField] = {
                  value: normalizedValue,
                  updated_at: new Date().toISOString(),
                  field_id: field.id,
                  original_name: field.name
                };
              }
            }
          }
        }
      } else {
        console.warn(`No custom fields array found for task ${taskId}`);
      }

      // Log what we're about to save
      console.log('Processed field data:', {
        taskId,
        fieldCount: Object.keys(fieldData.fieldValues).length,
        fields: Object.keys(fieldData.fieldValues).map(key => ({
          name: key,
          type: fieldData.customFields[key]?.type,
          hasValue: true
        }))
      });

      const updatedTask = await db.updateTaskCustomFields(taskId, fieldData);
      console.log('[Sync] Update result:', {
        success: !!updatedTask,
        taskId: updatedTask?.id
      });

      console.log('=== Sync Complete ===\n');

      return { 
        success: true,
        task: updatedTask
      };

    } catch (error) {
      console.error('[Sync] Error:', {
        message: error.message,
        code: error.code,
        detail: error.detail,
        stack: error.stack
      });
      return { 
        success: false, 
        error: error.message,
        details: error.response?.data 
      };
    }
  }

  // Helper method to normalize field values
  normalizeFieldValue(field, mapping) {
    if (!mapping || !mapping.transform) return null;
    
    try {
      return mapping.transform(field.value);
    } catch (error) {
      console.error(`Error normalizing field value:`, {field, error});
      return null;
    }
  }

  // Helper method to map field names and types
  mapFieldName(cleanName) {
    const fieldMap = {
      'Status Updates': { 
        column: 'status_updates', 
        type: 'text',
        transform: (value) => String(value)
      },
      'Client': { 
        column: 'client', 
        type: 'text',
        transform: (value) => String(value)
      },
      'Start Job!': { 
        column: 'start_job', 
        type: 'timestamp',
        transform: (value) => value ? new Date(value) : null
      },
      'Est. Revenue': { 
        column: 'est_revenue', 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Est. Cost': { 
        column: 'est_cost', 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Reason for Closed': { 
        column: 'reason_for_closed', 
        type: 'text',
        transform: (value) => String(value)
      },
      'Job Name': { 
        column: 'job_name', 
        type: 'text',
        transform: (value) => String(value)
      },
      'Milestone Date': { 
        column: 'milestone_date', 
        type: 'timestamp',
        transform: (value) => value ? new Date(value) : null
      },
      'Hours per Day': { 
        column: 'hours_per_day', 
        type: 'integer',
        transform: (value) => parseInt(value, 10)
      },
      // Additional fields stored in field_values JSONB
      'Expected Revenue': { 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Current Fee': { 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Fee': { 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Time Left': { 
        type: 'text',
        transform: (value) => String(value)
      },
      'Estimated Fee': { 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      },
      'Update Email': { 
        type: 'text',
        transform: (value) => String(value)
      },
      'Job Budget': { 
        type: 'decimal',
        transform: (value) => typeof value === 'number' ? value : null
      }
    };

    const mapping = fieldMap[cleanName];
    if (!mapping) return null;

    return {
      name: mapping.column || cleanName,
      type: mapping.type,
      transform: mapping.transform
    };
  }

  /**
   * Syncs task relationships to the database
   * @param {string} taskId - ID of the task to sync
   */
  async syncTaskRelationships(taskId) {
    try {
      const taskDetails = await clickup.getTaskDetails(taskId);
      if (!taskDetails) {
        console.warn(`No task details found for ${taskId}, skipping sync`);
        return;
      }

      const relationships = {
        parent_id: taskDetails.parent,  // Already normalized in clickup service
        custom_type: taskDetails.custom_type?.name,  // Already normalized in clickup service
        updated_at: new Date().toISOString()
      };

      // Log relationship data being saved
      console.log('\nSaving relationships:', {
        taskId,
        taskName: taskDetails.name,
        ...relationships
      });

      const updatedTask = await db.updateTaskRelationships(taskId, relationships);
      if (updatedTask) {
        console.log('Task relationships updated successfully:', {
          taskId,
          parentId: relationships.parent_id || 'none',
          customType: relationships.custom_type || 'none'
        });
      } else {
        console.warn('Task relationships update returned no data');
      }
    } catch (error) {
      console.error(`Error syncing relationships for task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Syncs custom task types from the workspace
   */
  async syncTaskTypes() {
    try {
      // Fetch custom task types from ClickUp
      const types = await clickup.getCustomTaskTypes(config.clickup.workspaceId);
      
      if (types.length === 0) {
        console.log('No custom task types to sync');
        return;
      }

      // Create task_types table if it doesn't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS task_types (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT,
          status TEXT,
          orderindex INTEGER,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Begin transaction
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        // Process each task type
        for (const type of types) {
          await client.query(`
            INSERT INTO task_types (id, name, color, status, orderindex, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              color = EXCLUDED.color,
              status = EXCLUDED.status,
              orderindex = EXCLUDED.orderindex,
              updated_at = CURRENT_TIMESTAMP
          `, [
            type.id,
            type.name,
            type.color,
            type.status,
            type.orderindex
          ]);
        }

        // Remove any task types that no longer exist in ClickUp
        const typeIds = types.map(t => t.id);
        await client.query(`
          DELETE FROM task_types
          WHERE id NOT IN (${typeIds.map((_, i) => `$${i + 1}`).join(',')})
        `, typeIds);

        await client.query('COMMIT');
        console.log(`Successfully synced ${types.length} task types`);

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error) {
      console.error('Error syncing task types:', error);
      // Log error but don't fail the sync process
      console.log('Continuing with sync despite task type error');
    }
  }
}

// Export a singleton instance of the service
module.exports = new SyncService(); 