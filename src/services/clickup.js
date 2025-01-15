// Required dependencies
const axios = require('axios');
const config = require('../config/config');

/**
 * Service class to handle all ClickUp API interactions
 */
class ClickUpService {
  /**
   * Initialize the ClickUp service with API configuration
   */
  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: {
        'Authorization': config.clickup.apiToken,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Retry a failed request with exponential backoff
   * @param {Function} fn - The function to retry
   * @param {number} retries - Number of retry attempts
   * @param {number} delay - Base delay between retries in ms
   * @returns {Promise} - Result of the request
   */
  async retryRequest(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        // If it's a 502 error or rate limit, wait and retry
        if ((error.response?.status === 502 || error.response?.status === 429) && i < retries - 1) {
          console.log(`Attempt ${i + 1} failed, retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1))); // Exponential backoff
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Get all spaces in a workspace
   * @param {string} workspaceId - ID of the workspace
   * @returns {Promise<Array>} List of spaces
   */
  async getSpaces(workspaceId) {
    try {
      const response = await this.client.get(`/team/${workspaceId}/space`);
      return response.data.spaces;
    } catch (error) {
      console.error(`Error fetching spaces for workspace ${workspaceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get details for a specific task
   * @param {string} taskId - ID of the task
   * @returns {Promise<Object|null>} Task details or null if not found
   */
  async getTaskDetails(taskId) {
    try {
      console.log(`[ClickUp] Starting API request for task ${taskId}`);
      
      const url = `/task/${taskId}`;
      const params = {
        custom_fields: true,
        include_subtasks: true,
        include_field_values: true
      };
      
      console.log('[ClickUp] Request details:', { url, params });

      const response = await this.retryRequest(
        () => this.client.get(url, { params }),
        3,
        2000
      );

      console.log('[ClickUp] Response status:', response.status);
      console.log('[ClickUp] Task name:', response.data.name);
      console.log('[ClickUp] Custom fields count:', response.data.custom_fields?.length || 0);

      return {
        ...response.data,
        custom_fields: response.data.custom_fields || [],
        parent: response.data.parent || null,
        custom_type: response.data.custom_type ? {
          id: response.data.custom_type.id,
          name: response.data.custom_type.name,
          color: response.data.custom_type.color
        } : null
      };

    } catch (error) {
      console.error('[ClickUp] Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      throw error;
    }
  }

  /**
   * Get all tasks in a space with pagination
   * @param {string} spaceId - ID of the space
   * @returns {Promise<Array>} List of all tasks
   */
  async getSpaceTasks(spaceId) {
    try {
      const allTasks = [];
      let page = 0;
      let hasMore = true;
      
      // Keep fetching pages until no more tasks are returned
      while (hasMore) {
        const response = await this.client.get(`/space/${spaceId}/task`, {
          params: { 
            page,
            subtasks: true,
            archived: false,
            include_closed: true
          }
        });
        const tasks = response.data.tasks;
        allTasks.push(...tasks);
        hasMore = tasks.length === 100; // ClickUp's default page size
        page++;

        // Add a small delay to avoid rate limiting
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      return allTasks;
    } catch (error) {
      console.error(`Error fetching space tasks ${spaceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get custom fields for a specific task
   * @param {string} taskId - ID of the task
   * @returns {Promise<Array>} List of custom fields
   */
  async getCustomFields(taskId) {
    const taskDetails = await this.getTaskDetails(taskId);
    if (!taskDetails) return []; // Handle case where task details couldn't be fetched
    return taskDetails.custom_fields || [];
  }

  /**
   * Get all folders in a space
   * @param {string} spaceId - ID of the space
   * @returns {Promise<Array>} List of folders
   */
  async getFolders(spaceId) {
    const response = await this.client.get(`/space/${spaceId}/folder`);
    return response.data.folders;
  }

  /**
   * Get lists in a space or folder
   * @param {string} spaceId - ID of the space
   * @param {string|null} folderId - Optional ID of the folder
   * @returns {Promise<Array>} List of lists
   */
  async getLists(spaceId, folderId = null) {
    // If folderId is provided, get lists in that folder
    if (folderId) {
      const response = await this.client.get(`/folder/${folderId}/list`);
      return response.data.lists;
    }
    // Otherwise get folderless lists in the space
    const response = await this.client.get(`/space/${spaceId}/list`);
    return response.data.lists;
  }

  /**
   * Get all tasks in a list
   * @param {string} listId - ID of the list
   * @returns {Promise<Array>} List of tasks
   */
  async getListTasks(listId) {
    try {
      const response = await this.retryRequest(
        () => this.client.get(`/list/${listId}/task`, {
          params: {
            subtasks: true,
            archived: false,
            include_closed: true,
            page: 0
          }
        }),
        3,
        2000
      );
      return response.data.tasks;
    } catch (error) {
      if (error.response?.status === 502) {
        console.error(`Temporary server error for list ${listId}, retrying...`);
        return [];
      }
      throw error;
    }
  }

  /**
   * Get custom task types for a workspace
   * @param {string} workspaceId - ID of the workspace
   * @returns {Promise<Array>} List of custom task types
   */
  async getCustomTaskTypes(workspaceId) {
    try {
      const response = await this.client.get(`/workspace/${workspaceId}/task_type`);
      return response.data.task_types || [];
    } catch (error) {
      console.error('Error fetching custom task types:', error);
      throw error;
    }
  }
}

// Export a singleton instance of the service
module.exports = new ClickUpService(); 