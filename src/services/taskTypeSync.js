const db = require('../db');
const clickup = require('./clickup');
const config = require('../config/config');

class TaskTypeSync {
    async syncTaskTypes() {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            const types = await clickup.getCustomTaskTypes(config.clickup.workspaceId);
            console.log(`Found ${types.length} task types in ClickUp`);

            for (const type of types) {
                await client.query(`
                    INSERT INTO task_types (
                        id, name, color, status, orderindex, workspace_id, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        color = EXCLUDED.color,
                        status = EXCLUDED.status,
                        orderindex = EXCLUDED.orderindex,
                        workspace_id = EXCLUDED.workspace_id,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    type.id,
                    type.name,
                    type.color || null,
                    type.status || 'active',
                    type.orderindex || 0,
                    config.clickup.workspaceId
                ]);
            }

            const typeIds = types.map(t => t.id);
            if (typeIds.length > 0) {
                await client.query(`
                    DELETE FROM task_types
                    WHERE id NOT IN (${typeIds.map((_, i) => `$${i + 1}`).join(',')})
                `, typeIds);
            }

            await client.query('COMMIT');
            return types;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error syncing task types:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async updateTaskTypeRelationships(taskId, typeId) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            const result = await client.query(`
                UPDATE clickup_task
                SET 
                    task_type_id = $2,
                    task_type_name = (SELECT name FROM task_types WHERE id = $2)
                WHERE id = $1
                RETURNING *
            `, [taskId, typeId]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating task type relationship:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = new TaskTypeSync(); 